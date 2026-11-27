"use client";

import { lazy, Suspense, type ComponentProps } from "react";

const ManagementPanel = lazy(() =>
  import("@/features/settings/workspace-factory-management-panel").then((module) => ({
    default: module.WorkspaceFactoryManagementPanel,
  })),
);

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
