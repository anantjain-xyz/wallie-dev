import Link from "next/link";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadFactoryActivityData } from "@/features/factory-activity/activity-data";
import { FactoryActivityPage } from "@/features/factory-activity/activity-page";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceActivityPath } from "@/lib/routes";

const idQuery = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const factoryQuery = z.union([z.literal("all"), idQuery]).default("all");
const actorQuery = idQuery.optional();

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factory = factoryQuery.safeParse(search[FACTORY_QUERY_PARAM]);
  if (!factory.success) return <FactoryUnavailable title="Activity" />;

  const [{ supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    factory.data === "all" ? [] : loadWorkspaceFactoryOptions(workspaceSlug),
  ]);

  const selection = resolveFactorySelection(factories, factory.data);
  if (selection.kind === "unavailable") return <FactoryUnavailable title="Activity" />;

  const actor = actorQuery.safeParse(search.actor);
  if (!actor.success) {
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader title="Activity" />
        <section className="ui-sheet space-y-3 px-6 py-12 text-center">
          <h2 className="text-sm font-semibold text-foreground">Actor filter unavailable</h2>
          <Link
            className="underline underline-offset-2 hover:text-foreground text-sm"
            href={workspaceActivityPath(workspace.slug, { factory: factory.data })}
          >
            Clear actor filter
          </Link>
        </section>
      </PageContainer>
    );
  }

  const selectedFactory = selection.kind === "factory" ? selection.factory : null;
  const data = await loadFactoryActivityData({
    supabase,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    filters: { factoryId: selectedFactory?.id, actorId: actor.data },
  });

  return (
    <FactoryActivityPage
      actorId={actor.data}
      data={data}
      factory={
        selectedFactory
          ? { id: selectedFactory.id, label: selectedFactory.name }
          : {
              id: "all",
              label: "All factories",
            }
      }
      workspaceSlug={workspace.slug}
    />
  );
}
