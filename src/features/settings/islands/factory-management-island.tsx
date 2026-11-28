"use client";

import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";

const ManagementPanel = lazy(() =>
  import("@/features/settings/workspace-factory-management-panel").then((module) => ({
    default: module.WorkspaceFactoryManagementPanel,
  })),
);

class FactoryManagementErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="type-body text-danger" role="alert">
          Could not load factory management.
        </p>
        <button
          className="ui-button min-h-11 sm:min-h-9"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload Settings
        </button>
      </div>
    );
  }
}

export function WorkspaceFactoryManagementIsland(props: ComponentProps<typeof ManagementPanel>) {
  return (
    <FactoryManagementErrorBoundary>
      <Suspense
        fallback={
          <p className="type-secondary text-muted" role="status">
            Loading factory management…
          </p>
        }
      >
        <ManagementPanel {...props} />
      </Suspense>
    </FactoryManagementErrorBoundary>
  );
}
