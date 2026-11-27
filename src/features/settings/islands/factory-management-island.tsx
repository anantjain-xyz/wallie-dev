"use client";

import Link from "next/link";
import { lazy, Suspense, type ComponentProps } from "react";

const ManagementPanel = lazy(() =>
  import("@/features/settings/workspace-factory-management-panel").then((module) => ({
    default: module.WorkspaceFactoryManagementPanel,
  })),
);

export function FactoryManagementCloseLink({ href }: { href: string }) {
  return (
    <Link
      aria-label="Close factory management"
      className="ui-button min-h-11 sm:min-h-9"
      href={href}
      onNavigate={() => {
        const directory = document.getElementById("factories");
        directory
          ?.querySelector<HTMLElement>("[data-settings-heading]")
          ?.focus({ preventScroll: true });
        directory?.scrollIntoView({ block: "start" });
      }}
      prefetch={false}
      scroll={false}
    >
      Close
    </Link>
  );
}

export function WorkspaceFactoryManagementIsland(props: ComponentProps<typeof ManagementPanel>) {
  return (
    <Suspense
      fallback={
        <p className="type-secondary text-muted" role="status">
          Loading factory management…
        </p>
      }
    >
      <ManagementPanel {...props} />
    </Suspense>
  );
}
