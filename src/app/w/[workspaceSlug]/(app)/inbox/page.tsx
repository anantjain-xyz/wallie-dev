import { notFound } from "next/navigation";

import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
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
  const kind = factoryInboxKindSchema.safeParse(search.kind).data;
  const [{ currentMember, supabase, workspace }, snapshot] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceRouteScope({ route: "inbox", workspaceSlug, search }),
  ]);
  const { factories, scope: selection } = snapshot;
  const handoff = <WorkspaceScopeHandoff snapshot={snapshot} />;
  if (selection.kind === "unavailable")
    return (
      <>
        {handoff}
        <FactoryInboxUnavailable
          factorySelector={
            <FactorySelector allowAll factories={factories} selectedValue="unavailable" />
          }
          kind={kind}
          workspaceSlug={workspace.slug}
        />
      </>
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
    <>
      {handoff}
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
    </>
  );
}
