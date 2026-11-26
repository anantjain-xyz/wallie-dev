import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import { failureCohortIdSchema } from "@/lib/factory-failures/cohort-contracts";
import { listFailureRevisionPage, loadFailureActivation } from "@/lib/factory-failures/cohorts";

export async function GET(
  request: Request,
  { params }: RouteContext<"/w/[workspaceSlug]/failure-groups/revisions">,
) {
  const { workspaceSlug } = await params;
  const query = new URL(request.url).searchParams;
  const before = failureCohortIdSchema.safeParse(query.get("before"));
  const factory = failureCohortIdSchema.safeParse(query.get("factory"));
  if (!before.success || !factory.success) return new Response(null, { status: 400 });
  const scope = await loadFailureGroupScope(workspaceSlug, factory.data);
  if (!scope) return new Response(null, { status: 404 });
  const active = await loadFailureActivation(scope.supabase, scope);
  const page = await listFailureRevisionPage(scope.supabase, scope, active, before.data);
  if (!page) return new Response(null, { status: 404 });
  return Response.json(page, { headers: { "Cache-Control": "private, no-store" } });
}
