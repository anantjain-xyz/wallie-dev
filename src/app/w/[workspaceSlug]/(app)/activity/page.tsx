import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
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
  activityFactoryQuery,
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
  const [{ supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = activityFactoryQuery.safeParse(search[FACTORY_QUERY_PARAM]);
  const selection = resolveFactorySelection(factories, factory.success ? factory.data : "");
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
    <FactoryActivityPage
      actorLabel={selectedActor?.label ?? (query.actor ? "Actor unavailable" : "All actors")}
      data={data}
      factorySelector={selector}
      invalidCursors={invalidCursors}
      invalidStatus={!status.success}
      query={query}
      workspaceSlug={workspace.slug}
    />
  );
}
