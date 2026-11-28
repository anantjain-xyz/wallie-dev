"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode, Ref } from "react";

import { WorkspaceNavigation } from "@/components/app-shell/navigation-motion";
import type { WorkspaceDestination } from "@/components/app-shell/workspace-location";
import { cn } from "@/lib/utils";

export type ShellNavItem = {
  active: boolean;
  href: string;
  id: WorkspaceDestination;
  label: string;
};

const navIconPaths = {
  sessions: "M5 4h8M5 8h8m-8 4h8M2.5 4h.1m-.1 4h.1m-.1 4h.1",
  inbox: "M2.5 8.5 4.5 3.5h7l2 5v4h-11zM2.5 8.5h3l1 1.5h3l1-1.5h3",
  runs: "M3 12V8m5 4V4m5 8V6M2 13.5h12",
  insights: "M3 3.5v9h10.5M5.5 10l2.3-3 2 1.5 3.2-4",
  factory: "M2.5 13V6.5L6 8V5l3.5 2 1-4h2l1 10zM5 10h.1m2.9 0h.1m2.9 0h.1",
  settings: "M3 4.5h10m-10 7h10M6 3v3m4 4v3",
} satisfies Record<ShellNavItem["id"], string>;

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
  getLinkProps: (
    item: ShellNavItem,
  ) => Pick<
    ComponentProps<typeof Link>,
    "href" | "onClick" | "onFocus" | "onPointerEnter" | "prefetch"
  >;
  items: ShellNavItem[];
};

export function WorkspaceNavLinks({
  getLinkProps,
  items,
  mobile = false,
}: WorkspaceNavLinksProps & { mobile?: boolean }) {
  return (
    <ul className="flex flex-1 flex-col gap-0.5">
      {items.map((item) => (
        <li
          className={cn(item.id === "settings" && "mt-auto border-t border-border pt-2")}
          key={item.id}
        >
          <Link
            {...getLinkProps(item)}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "ui-shell-nav-link w-full min-w-0 gap-2.5",
              item.active && "ui-shell-nav-link-active",
              mobile && "min-h-11",
            )}
          >
            <NavigationIcon>
              <path d={navIconPaths[item.id]} />
            </NavigationIcon>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function WorkspaceSidebar({
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
  return (
    <aside
      className={cn(
        "sticky top-[var(--shell-scroll-padding)] hidden h-[calc(100svh-var(--shell-scroll-padding))] w-44 shrink-0 self-start border-r border-border bg-canvas",
        wideContent ? "xl:block" : "lg:block",
      )}
      data-shell-rail=""
      ref={sidebarRef}
    >
      <div className="flex h-full flex-col overflow-y-auto overscroll-contain p-2 pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))]">
        <WorkspaceNavigation pathname={pathname} className="flex flex-1 flex-col gap-4">
          <WorkspaceNavLinks getLinkProps={getLinkProps} items={items} />
        </WorkspaceNavigation>
      </div>
    </aside>
  );
}
