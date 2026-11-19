"use client";

import Link from "next/link";
import { useSyncExternalStore, type ComponentProps, type ReactNode, type Ref } from "react";

import { WorkspaceNavigation } from "@/components/app-shell/navigation-motion";
import { Tooltip } from "@/components/ui/tooltip";
import { workspaceNavSections, type WorkspaceNavItem } from "@/lib/routes";
import { cn } from "@/lib/utils";

const sidebarStorageKey = "wallie-sidebar:v1";
const sidebarListeners = new Set<() => void>();
let sidebarStorageFallback = false;

function subscribeSidebar(listener: () => void) {
  sidebarListeners.add(listener);
  function handleStorage(event: StorageEvent) {
    if (event.key === sidebarStorageKey || event.key === null) listener();
  }
  window.addEventListener("storage", handleStorage);
  return () => {
    sidebarListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function readSidebarPreference() {
  try {
    return window.localStorage.getItem(sidebarStorageKey) === "collapsed";
  } catch {
    return sidebarStorageFallback;
  }
}

function writeSidebarPreference(collapsed: boolean) {
  sidebarStorageFallback = collapsed;
  try {
    window.localStorage.setItem(sidebarStorageKey, collapsed ? "collapsed" : "expanded");
  } catch {
    // The sidebar still responds when the browser blocks persistence.
  }
  for (const listener of sidebarListeners) listener();
}

function getServerSidebarPreference() {
  return false;
}

const navIconPaths = {
  pipeline: "M2.5 3.5h11v9h-11zM6.2 3.5v9m3.6-9v9",
  sessions: "M5 4h8M5 8h8m-8 4h8M2.5 4h.1m-.1 4h.1m-.1 4h.1",
  runs: "M2.5 8h2l1.7-4 3.4 8 1.7-4h2.2",
  activity: "M3 12V8m5 4V4m5 8V6M2 13.5h12",
  governance: "M8 2.5 13 4.5v3.2c0 3-2 4.9-5 6-3-1.1-5-3-5-6V4.5zM6 8l1.4 1.4L10 6.8",
  agents:
    "M4 13v-1.5A3.5 3.5 0 0 1 7.5 8h1a3.5 3.5 0 0 1 3.5 3.5V13zM10 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  "factory-definition": "M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4m-4 2h4",
  settings: "M3 4.5h10m-10 7h10M6 3v3m4 4v3",
} satisfies Record<WorkspaceNavItem["id"], string>;

function NavigationIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.2"
      viewBox="0 0 16 16"
    >
      {children}
    </svg>
  );
}

export function NavigationMenuIcon() {
  return (
    <NavigationIcon>
      <path d="M2.5 4h11m-11 4h11m-11 4h11" />
    </NavigationIcon>
  );
}

type WorkspaceNavLinksProps = {
  activeItem: WorkspaceNavItem | undefined;
  getLinkProps: (
    item: WorkspaceNavItem,
  ) => Pick<
    ComponentProps<typeof Link>,
    "href" | "onClick" | "onFocus" | "onPointerEnter" | "prefetch"
  >;
  items: WorkspaceNavItem[];
};

export function WorkspaceNavLinks({
  activeItem,
  collapsed = false,
  getLinkProps,
  items,
  mobile = false,
}: WorkspaceNavLinksProps & { collapsed?: boolean; mobile?: boolean }) {
  return workspaceNavSections.map((section) => {
    const sectionItems = items.filter((item) => item.section === section);
    if (sectionItems.length === 0) return null;

    const footer = section === "Footer";
    return (
      <div key={section} className={cn(footer && "mt-auto border-t border-border pt-2")}>
        {footer || collapsed ? null : (
          <p className="px-2.5 pb-1.5 type-label text-muted">{section}</p>
        )}
        <ul aria-label={footer || collapsed ? undefined : section} className="space-y-0.5">
          {sectionItems.map((item) => {
            const active = item.id === activeItem?.id;
            const link = (
              <Link
                {...getLinkProps(item)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "ui-shell-nav-link w-full min-w-0 gap-2.5",
                  active && "ui-shell-nav-link-active",
                  collapsed && "justify-center px-0 lg:px-0",
                  mobile && "min-h-11",
                )}
              >
                <NavigationIcon>
                  <path d={navIconPaths[item.id]} />
                </NavigationIcon>
                <span className={collapsed ? "sr-only" : "min-w-0 break-words"}>{item.label}</span>
              </Link>
            );

            return (
              <li key={item.id}>
                {collapsed ? <Tooltip content={item.label}>{link}</Tooltip> : link}
              </li>
            );
          })}
        </ul>
      </div>
    );
  });
}

export function WorkspaceSidebar({
  activeItem,
  getLinkProps,
  items,
  pathname,
  sidebarRef,
  wideContent,
}: WorkspaceNavLinksProps & {
  pathname: string;
  sidebarRef: Ref<HTMLElement>;
  wideContent: boolean;
}) {
  const collapsed = useSyncExternalStore(
    subscribeSidebar,
    readSidebarPreference,
    getServerSidebarPreference,
  );
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <aside
      className={cn(
        "sticky top-[var(--shell-scroll-padding)] hidden h-[calc(100svh-var(--shell-scroll-padding))] shrink-0 self-start border-r border-border bg-canvas",
        wideContent ? "xl:block" : "lg:block",
        collapsed ? "w-14" : "w-44",
      )}
      data-collapsed={collapsed ? "" : undefined}
      data-shell-rail=""
      ref={sidebarRef}
    >
      <div className="flex h-full flex-col overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))]">
        <div className={cn("mb-2 flex", collapsed ? "justify-center" : "justify-end")}>
          <Tooltip content={label}>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={label}
              className="ui-icon-button"
              onClick={() => writeSidebarPreference(!collapsed)}
            >
              <NavigationIcon>
                <path d="M2.5 3h11v10h-11zM6 3v10" />
                <path d={collapsed ? "m9 6 2 2-2 2" : "m11 6-2 2 2 2"} />
              </NavigationIcon>
            </button>
          </Tooltip>
        </div>
        <WorkspaceNavigation pathname={pathname} className="flex flex-1 flex-col gap-4">
          <WorkspaceNavLinks
            activeItem={activeItem}
            collapsed={collapsed}
            getLinkProps={getLinkProps}
            items={items}
          />
        </WorkspaceNavigation>
      </div>
    </aside>
  );
}
