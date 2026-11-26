import { z } from "zod";

import { searchActivityActors } from "@/features/factory-activity/activity-actors-data";
import { activityFactoryQuery } from "@/features/factory-activity/activity-query.server";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

const actorSearch = z.object({
  factory: activityFactoryQuery,
  q: z.string().trim().max(100),
});
const headers = { "Cache-Control": "private, no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceSlug: string }> },
) {
  const query = new URL(request.url).searchParams;
  const search = actorSearch.safeParse({
    factory: query.get("factory") ?? undefined,
    q: query.get("q") ?? "",
  });
  if (!search.success) return new Response(null, { status: 400, headers });

  const { workspaceSlug } = await params;
  const { supabase, workspace } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const { factory, q } = search.data;
  if (factory !== "all") {
    const { data, error } = await supabase
      .from("factories")
      .select("id")
      .eq("workspace_id", workspace.id)
      .eq("id", factory)
      .maybeSingle();
    if (error) return new Response(null, { status: 503, headers });
    if (!data) return new Response(null, { status: 404, headers });
  }

  const result = await searchActivityActors({ supabase, workspaceId: workspace.id, factory }, q);
  if (!result) return new Response(null, { status: 503, headers });
  return Response.json(result, { headers });
}
