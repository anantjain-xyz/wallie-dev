import { loadBrowserSessionFactories } from "@/lib/sessions/browser-factory";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const params = workspaceIdParamsSchema.safeParse(await context.params);
  if (!params.success)
    return Response.json({ error: "Workspace id is invalid." }, { status: 400, headers });
  const access = await requireWorkspaceAccessById(params.data.workspaceId);
  if (!access.ok) return Response.json({ error: access.error }, { status: access.status, headers });

  const { currentMember, supabase, workspace } = access.context;
  const factories = await loadBrowserSessionFactories({
    member: currentMember,
    supabase,
    workspaceId: workspace.id,
  });
  return Response.json({ factories: factories.map(({ id, name }) => ({ id, name })) }, { headers });
}
