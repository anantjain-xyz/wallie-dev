import { notFound } from "next/navigation";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryInboxPage, FactoryInboxUnavailable } from "@/features/factory-inbox/inbox-page";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { FactoryInboxCursorError, loadFactoryInbox } from "@/lib/factories/inbox";
import { factoryInboxKindSchema } from "@/lib/factories/inbox-schema";

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factoryQuery = search[FACTORY_QUERY_PARAM] ?? "all";
  const kind = factoryInboxKindSchema.safeParse(search.kind).data;
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selection = resolveFactorySelection(factories, factoryQuery);
  if (selection.kind === "unavailable")
    return (
      <FactoryInboxUnavailable
        factorySelector={
          <FactorySelector allowAll factories={factories} selectedValue="unavailable" />
        }
        kind={kind}
        workspaceSlug={workspace.slug}
      />
    );

  const factoryId = selection.kind === "factory" ? selection.factory.id : null;
  const cursor = search.cursor ?? null;
  if (Array.isArray(cursor)) notFound();
  const inbox = await loadFactoryInbox({
    supabase,
    workspaceId: workspace.id,
    factoryId,
    kind,
    cursor,
  }).catch((error: unknown) => {
    if (error instanceof FactoryInboxCursorError) notFound();
    throw error;
  });

  return (
    <FactoryInboxPage
      key={JSON.stringify([workspace.id, factoryId, kind, cursor])}
      cursor={cursor}
      factoryId={factoryId}
      factorySelector={
        <FactorySelector allowAll factories={factories} selectedValue={factoryId ?? "all"} />
      }
      initialInbox={inbox}
      initialNow={new Date().toISOString()}
      kind={kind}
      memberId={currentMember.id}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
