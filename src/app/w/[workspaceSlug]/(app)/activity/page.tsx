import Link from "next/link";

import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadSelectedActivityActor } from "@/features/factory-activity/activity-actors-data";
import { loadFactoryActivityData } from "@/features/factory-activity/activity-data";
import { FactoryActivityPage } from "@/features/factory-activity/activity-page";
import {
  ACTIVITY_CURSOR_PARAMS,
  activityHref,
  type ActivityQuery,
} from "@/features/factory-activity/activity-query";
import {
  activityIdQuery,
  activityStatusQuery,
  readActivityCursor,
} from "@/features/factory-activity/activity-query.server";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const [{ supabase, workspace }, snapshot] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceRouteScope({
      route: "feed",
      workspaceSlug,
      search,
      resetParams: ACTIVITY_CURSOR_PARAMS,
    }),
  ]);
  const { factories, scope: selection } = snapshot;
  const handoff = <WorkspaceScopeHandoff snapshot={snapshot} />;
  const actor = activityIdQuery.optional().safeParse(search.actor);
  const status = activityStatusQuery.safeParse(search.status);
  const factoryId = selection.kind === "factory" ? selection.factory.id : "all";
  const query: ActivityQuery = {
    factory: factoryId,
    actor: actor.success ? actor.data : undefined,
    status: status.success ? status.data : undefined,
  };
  const selector = (
    <FactorySelector
      allowAll
      factories={factories}
      resetParams={ACTIVITY_CURSOR_PARAMS}
      selectedValue={selection.kind === "unavailable" ? "unavailable" : factoryId}
    />
  );

  if (selection.kind === "unavailable" || !actor.success) {
    const unavailableFactory = selection.kind === "unavailable";
    return (
      <PageContainer className="pt-5 sm:pt-10">
        {handoff}
        <PageHeader actions={selector} actionsRightOnDesktop title="Activity" />
        <section className="ui-sheet px-6 py-12 text-center">
          <h2 className="type-section-title">
            {unavailableFactory ? "Factory unavailable" : "Actor filter unavailable"}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {unavailableFactory
              ? "Choose a factory you can access."
              : "Clear the actor filter to see activity in this factory scope."}
          </p>
          <Link className="ui-button mt-4" href={activityHref(workspace.slug, query)}>
            {unavailableFactory
              ? "Show activity for all accessible factories"
              : "Clear actor filter"}
          </Link>
        </section>
      </PageContainer>
    );
  }

  const invalidCursors = {
    sessions:
      search.sessionsBefore !== undefined &&
      !readActivityCursor(search.sessionsBefore, workspace.id, "sessions", query),
    runs:
      search.runsBefore !== undefined &&
      !readActivityCursor(search.runsBefore, workspace.id, "runs", query),
  };
  if (!invalidCursors.sessions && typeof search.sessionsBefore === "string")
    query.sessionsBefore = search.sessionsBefore;
  if (!invalidCursors.runs && typeof search.runsBefore === "string")
    query.runsBefore = search.runsBefore;

  const [data, selectedActor] = await Promise.all([
    loadFactoryActivityData({
      supabase,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      query,
    }),
    loadSelectedActivityActor(
      { supabase, workspaceId: workspace.id, factory: query.factory },
      query.actor,
    ),
  ]);

  return (
    <>
      {handoff}
      <FactoryActivityPage
        actorLabel={selectedActor?.label ?? (query.actor ? "Actor unavailable" : "All actors")}
        data={data}
        factorySelector={selector}
        invalidCursors={invalidCursors}
        invalidStatus={!status.success}
        query={query}
        workspaceSlug={workspace.slug}
      />
    </>
  );
}
