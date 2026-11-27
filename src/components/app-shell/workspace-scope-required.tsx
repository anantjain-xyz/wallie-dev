import {
  WorkspaceScopeHandoff,
  type WorkspaceScopeSnapshot,
} from "@/components/app-shell/workspace-scope-context";
import {
  workspaceScopeOptions,
  workspaceLocationForRoute,
  type WorkspaceRoute,
} from "@/components/app-shell/workspace-location";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FactorySelector } from "@/features/factories/factory-selector";

export function WorkspaceScopeRequired({
  route,
  snapshot,
  title,
  workspaceSlug,
}: {
  route: WorkspaceRoute;
  snapshot: WorkspaceScopeSnapshot;
  title: string;
  workspaceSlug: string;
}) {
  const choices = workspaceScopeOptions(
    workspaceLocationForRoute(route, workspaceSlug),
    snapshot.factories,
  );
  const unavailable = snapshot.scope.kind === "unavailable";
  return (
    <PageContainer>
      <WorkspaceScopeHandoff snapshot={snapshot} />
      <PageHeader
        title={title}
        actionsRightOnDesktop
        actions={
          choices.length ? (
            <FactorySelector
              factories={choices}
              resetParams={snapshot.resetParams}
              selectedValue="unavailable"
            />
          ) : undefined
        }
      />
      <section className="ui-sheet space-y-2 px-6 py-10 text-center">
        <h2 className="type-section-title">
          {unavailable ? "Factory unavailable" : "Choose a factory"}
        </h2>
        <p className="type-secondary text-muted">
          {choices.length
            ? "Select a factory to open this view."
            : "You don’t have access to a factory for this view. Ask a workspace admin for access."}
        </p>
      </section>
    </PageContainer>
  );
}
