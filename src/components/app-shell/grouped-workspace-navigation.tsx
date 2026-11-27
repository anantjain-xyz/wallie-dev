import Link from "next/link";

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
  { id: "activity", label: "Activity", entry: "runs" },
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
  hash,
  pathname,
  preferRememberedScope,
  returnTo,
  scope,
  workspaceSlug,
}: {
  canManageDefinition: boolean;
  factories: readonly FactorySelectionOption[];
  hash?: string;
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
  const configurationEntry = definition ? "definition" : "agents";
  const link = (route: WorkspaceRoute) =>
    workspaceScopeHref(route, workspaceSlug, scope, preferRememberedScope);

  const sidebar = destinations.map(({ id, label, entry }) => {
    const active = id === destination;
    const route =
      active && location && !fromInbox
        ? location.route
        : id === "factory"
          ? configurationEntry
          : entry;
    return {
      id,
      label,
      active,
      href: active && fromInbox ? browseReturn.href : link(route),
    };
  });

  function tab(
    route: WorkspaceRoute,
    label: string,
    active = location?.tab === label,
  ): NavigationLink {
    return { active, href: link(route), label };
  }
  function section(route: WorkspaceRoute, label: string): NavigationLink {
    return { active: location?.route === route, href: link(route), label };
  }

  let tabs: NavigationLink[] = [];
  let sections: NavigationLink[] = [];
  if (destination === "activity") {
    tabs = [tab("runs", "Runs"), tab("feed", "Feed")];
  } else if (destination === "insights") {
    tabs = [
      tab("analytics", "Analytics"),
      tab("failures", "Failures"),
      tab("benchmarks", "Benchmarks"),
    ];
    if (location?.tab === "Failures") {
      sections = [section("failures", "Failure groups"), section("improvements", "Improvements")];
    }
  } else if (destination === "factory") {
    tabs = [tab(configurationEntry, "Configuration")];
    if (managed) tabs.push(tab("context", "Knowledge"));
    if (location?.tab === "Knowledge") {
      if (managed) sections = [section("context", "Context"), section("memory", "Memory")];
    } else {
      if (definition) {
        const pipeline = hash === "#definition-field-stages";
        const active = location?.route === "definition";
        const canOpenPipeline = scope.kind === "factory" && scope.factory.status === "active";
        sections.push({ ...section("definition", "Definition"), active: active && !pipeline });
        if (canOpenPipeline)
          sections.push({
            active: active && pipeline,
            href: `${link("definition")}#definition-field-stages`,
            label: "Pipeline",
          });
      }
      sections.push(section("agents", "Agents"), section("scorers", "Scorers"));
      if (activeManaged)
        sections.push(
          section("automations", "Automations"),
          section("workflows", "Graph workflows"),
        );
      if (managed) sections.push(section("governance", "Access"));
    }
  }

  return { activeItem: sidebar.find((item) => item.active), sections, sidebar, tabs };
}

export function WorkspaceGroupTabs({
  label,
  sections,
  tabs,
}: {
  label: string;
  sections: readonly NavigationLink[];
  tabs: readonly NavigationLink[];
}) {
  if (tabs.length === 0) return null;
  const links = (entries: readonly NavigationLink[]) =>
    entries.map(({ active, href, label }) => (
      <Link
        aria-current={active ? "page" : undefined}
        className={cn(
          "ui-top-nav-tab min-h-11 text-wrap sm:min-h-8",
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
      <div className="mx-auto max-w-[1080px] px-4 py-2 sm:px-8">
        <nav aria-label={`${label} views`} className="flex flex-wrap gap-x-1">
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
