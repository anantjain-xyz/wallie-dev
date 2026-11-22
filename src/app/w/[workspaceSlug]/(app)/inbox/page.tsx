import { notFound } from "next/navigation";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { FactoryInboxPage } from "@/features/factory-inbox/inbox-page";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { FactoryInboxCursorError, loadFactoryInbox } from "@/lib/factories/inbox";

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factoryQuery = search[FACTORY_QUERY_PARAM] ?? "all";
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    factoryQuery === "all" ? [] : loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const selection = resolveFactorySelection(factories, factoryQuery);
  if (selection.kind === "unavailable")
    return <FactoryUnavailable title="Inbox" workspaceSlug={workspaceSlug} />;

  const factoryId = selection.kind === "factory" ? selection.factory.id : null;
  const cursor = search.cursor ?? null;
  if (Array.isArray(cursor)) notFound();
  const inbox = await loadFactoryInbox({
    supabase,
    workspaceId: workspace.id,
    factoryId,
    cursor,
  }).catch((error: unknown) => {
    if (error instanceof FactoryInboxCursorError) notFound();
    throw error;
  });

  return (
    <FactoryInboxPage
      key={JSON.stringify([workspace.id, factoryId, cursor])}
      cursor={cursor}
      factoryId={factoryId}
      initialInbox={inbox}
      initialNow={new Date().toISOString()}
      memberId={currentMember.id}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
