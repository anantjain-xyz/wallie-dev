import {
  cancelFactoryDefinitionSmokeTest,
  readFactoryDefinitionSmokeTest,
} from "@/lib/factory-definitions/candidate-smoke";
import {
  candidateSmokeCancelQuerySchema,
  candidateSmokeHistoryQuerySchema,
  candidateSmokeIdSchema,
} from "@/lib/factory-definitions/candidate-smoke-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string; testId: string }> };
const headers = { "Cache-Control": "private, no-store" };

function respond(body: unknown, status = 200) {
  return Response.json(body, { headers, status });
}

export async function GET(request: Request, { params }: RouteContext) {
  const routeParams = await params;
  const workspace = workspaceIdParamsSchema.safeParse(routeParams);
  const testId = candidateSmokeIdSchema.safeParse(routeParams.testId);
  const search = new URL(request.url).searchParams;
  const query = candidateSmokeHistoryQuerySchema.safeParse(Object.fromEntries(search));
  if (!workspace.success || !testId.success || !query.success || search.size !== 3) {
    return respond({ error: "Specify an exact candidate and smoke test ID." }, 400);
  }

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);

    const result = await readFactoryDefinitionSmokeTest({
      client: access.context.supabase,
      workspaceId: access.context.workspace.id,
      testId: testId.data,
      ...query.data,
    });
    return result.ok
      ? respond({ test: result.test })
      : respond({ error: result.error }, result.status);
  } catch {
    return respond({ error: "Could not load the candidate smoke test." }, 500);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const routeParams = await params;
  const workspace = workspaceIdParamsSchema.safeParse(routeParams);
  const testId = candidateSmokeIdSchema.safeParse(routeParams.testId);
  const search = new URL(request.url).searchParams;
  const query = candidateSmokeCancelQuerySchema.safeParse(Object.fromEntries(search));
  if (!workspace.success || !testId.success || !query.success || search.size !== 1) {
    return respond(
      { error: "Specify a workspace, candidate smoke test ID, and definition digest." },
      400,
    );
  }

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);

    const result = await cancelFactoryDefinitionSmokeTest({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      actorUserId: access.context.user.id,
      testId: testId.data,
      digest: query.data.digest,
    });
    return result.ok
      ? respond({ test: result.test })
      : respond({ error: result.error }, result.status);
  } catch {
    return respond({ error: "Could not cancel the candidate smoke test." }, 500);
  }
}
