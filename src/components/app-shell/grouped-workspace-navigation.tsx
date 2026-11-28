import Link from "next/link";
import { useEffect, useRef } from "react";

import {
  matchWorkspaceLocation,
  workspaceScopeHref,
  type WorkspaceDestination,
  type WorkspaceRoute,
  type WorkspaceScope,
} from "@/components/app-shell/workspace-location";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { parseSessionBrowseReturn } from "@/lib/sessions/browse-return";
import { cn } from "@/lib/utils";

const destinations = [
  { id: "inbox", label: "Inbox", entry: "inbox" },
  { id: "sessions", label: "Sessions", entry: "sessions" },
  { id: "runs", label: "Runs", entry: "runs" },
  { id: "insights", label: "Insights", entry: "analytics" },
  { id: "factory", label: "Factory", entry: "agents" },
  { id: "settings", label: "Settings", entry: "settings" },
] as const satisfies readonly { id: WorkspaceDestination; label: string; entry: WorkspaceRoute }[];

type NavigationLink = {
  active: boolean;
  href: string;
  label: string;
};

export function getGroupedWorkspaceNavigation({
  canManageDefinition,
  factories,
  pathname,
  preferRememberedScope,
  returnTo,
  scope,
  workspaceSlug,
}: {
  canManageDefinition: boolean;
  factories: readonly FactorySelectionOption[];
  pathname: string;
  preferRememberedScope?: boolean;
  returnTo?: string | null;
  scope: WorkspaceScope;
  workspaceSlug: string;
}) {
  const location = matchWorkspaceLocation(pathname, workspaceSlug);
  const browseReturn =
    location?.route === "sessions" && location.detail
      ? parseSessionBrowseReturn(workspaceSlug, returnTo)
      : null;
  const fromInbox = browseReturn?.label === "Inbox";
  const destination = fromInbox ? "inbox" : location?.destination;
  const managed = factories.some((factory) => factory.canManage);
  const activeManaged = factories.some(
    (factory) => factory.canManage && factory.status === "active",
  );
  const definition = canManageDefinition && factories.some(({ status }) => status === "active");
  const factoryEntry = definition ? "definition" : "agents";
  const unresolvedScope = scope.kind === "global" || scope.kind === "resource-pending";
  const link = (route: WorkspaceRoute, fromFactory = false) =>
    workspaceScopeHref(
      route,
      workspaceSlug,
      fromFactory && unresolvedScope ? { kind: "pick" } : scope,
      preferRememberedScope,
    );

  const sidebar = destinations.map(({ id, label, entry }) => {
    const active = id === destination;
    const route =
      active && location && !fromInbox ? location.route : id === "factory" ? factoryEntry : entry;
    return {
      id,
      label,
      active,
      href: active && fromInbox ? browseReturn.href : link(route, active && id === "factory"),
    };
  });

  function tab(route: WorkspaceRoute, label: string): NavigationLink {
    return { active: location?.tab === label, href: link(route), label };
  }
  function routeTab(route: WorkspaceRoute, label: string): NavigationLink {
    return {
      active: location?.route === route,
      href: link(route, destination === "factory"),
      label,
    };
  }

  let tabs: NavigationLink[] = [];
  let sections: NavigationLink[] = [];
  if (destination === "insights") {
    tabs = [
      tab("analytics", "Analytics"),
      tab("failures", "Failures"),
      tab("benchmarks", "Benchmarks"),
    ];
    if (location?.tab === "Failures") {
      sections = [routeTab("failures", "Failure groups"), routeTab("improvements", "Improvements")];
    }
  } else if (destination === "factory") {
    tabs = [
      ...(definition ? [routeTab("definition", "Pipeline")] : []),
      ...(activeManaged ? [routeTab("workflows", "Graph workflows")] : []),
      routeTab("agents", "Agents"),
      ...(managed ? [routeTab("context", "Context"), routeTab("memory", "Memory")] : []),
      routeTab("scorers", "Scorers"),
      ...(activeManaged ? [routeTab("automations", "Automations")] : []),
      ...(managed ? [routeTab("governance", "Access")] : []),
    ];
  }

  return { activeItem: sidebar.find((item) => item.active), sections, sidebar, tabs };
}

function revealFactoryTab(row: HTMLElement, tab: Element) {
  const { left, right } = row.getBoundingClientRect();
  const bounds = tab.getBoundingClientRect();
  if (bounds.left < left + 4) row.scrollLeft += bounds.left - (left + 4);
  else if (bounds.right > right - 4) row.scrollLeft += bounds.right - (right - 4);
}

export function WorkspaceGroupTabs({
  label,
  sections,
  singleRow,
  tabs,
}: {
  label: string;
  sections: readonly NavigationLink[];
  singleRow?: boolean;
  tabs: readonly NavigationLink[];
}) {
  const rowRef = useRef<HTMLElement>(null);
  const activeLabel = singleRow ? tabs.find(({ active }) => active)?.label : undefined;

  useEffect(() => {
    const row = rowRef.current;
    const current = row?.querySelector('[aria-current="page"]');
    if (!row || !current) return;
    revealFactoryTab(row, current);
    const resize = new ResizeObserver(() => revealFactoryTab(row, current));
    resize.observe(row);
    return () => resize.disconnect();
  }, [activeLabel, tabs.length]);

  if (tabs.length === 0) return null;
  const links = (entries: readonly NavigationLink[]) =>
    entries.map(({ active, href, label }) => (
      <Link
        aria-current={active ? "page" : undefined}
        className={cn(
          "ui-top-nav-tab min-h-11 sm:min-h-8",
          singleRow ? "shrink-0" : "text-wrap",
          active && "ui-top-nav-tab-active",
        )}
        href={href}
        key={label}
        prefetch={false}
      >
        {label}
      </Link>
    ));

  return (
    <div className="border-b border-border">
      <div className={cn("mx-auto max-w-[1080px] px-4 sm:px-8", singleRow ? "py-1" : "py-2")}>
        <nav
          aria-label={`${label} views`}
          className={cn(
            "flex gap-x-1",
            singleRow
              ? "overflow-x-auto overscroll-x-contain scroll-px-1 p-1 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border-strong"
              : "flex-wrap",
          )}
          onFocus={
            singleRow
              ? ({ currentTarget, target }) => {
                  if (target.matches(":focus-visible")) revealFactoryTab(currentTarget, target);
                }
              : undefined
          }
          ref={singleRow ? rowRef : undefined}
        >
          {links(tabs)}
        </nav>
        {sections.length ? (
          <nav
            aria-label={`${label} sections`}
            className="mt-1 flex flex-wrap gap-x-1 border-t border-border pt-1"
          >
            {links(sections)}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
