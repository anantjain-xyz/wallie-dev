import { FactoryInboxCursorError, loadFactoryInbox } from "@/lib/factories/inbox";
import { factoryInboxQuerySchema } from "@/lib/factories/inbox-schema";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const entries = Object.fromEntries(search);
  const query = factoryInboxQuerySchema.safeParse(entries);
  if (!query.success || Object.keys(entries).length !== search.size) {
    return Response.json({ error: "Invalid Inbox request." }, { status: 400, headers });
  }

  try {
    const { workspaceId, factoryId, cursor } = query.data;
    const access = await requireWorkspaceAccessById(workspaceId);
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status, headers });
    }

    const inbox = await loadFactoryInbox({
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
      factoryId,
      cursor,
    });
    return inbox
      ? Response.json(inbox, { headers })
      : Response.json({ error: "Inbox not found." }, { status: 404, headers });
  } catch (error) {
    if (error instanceof FactoryInboxCursorError) {
      return Response.json({ error: "Invalid Inbox cursor." }, { status: 400, headers });
    }
    return Response.json({ error: "Could not load Inbox." }, { status: 500, headers });
  }
}
