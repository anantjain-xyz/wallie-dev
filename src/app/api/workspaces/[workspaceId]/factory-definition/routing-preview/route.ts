import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { selectFactory } from "@/lib/factory-definitions/storage";
import {
  routingPreviewRequestSchema,
  routingPreviewResponseSchema,
} from "@/lib/model-routing/decision-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const headers = { "Cache-Control": "private, no-store" };

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const route = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!route.success) return errorResponse("Invalid workspace or factory ID.", 400);

  try {
    const access = await requireWorkspaceAccessById(route.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return errorResponse(access.error, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return errorResponse(body.message, 400);
    const preview = routingPreviewRequestSchema.safeParse(body.value);
    if (!preview.success)
      return errorResponse("Specify the saved draft and a task class slug.", 400);

    const { workspace, user, supabase } = access.context;
    const factory = await selectFactory(supabase, workspace.id, route.data.factoryId);
    if (factory.error) throw factory.error;
    if (!factory.data) return errorResponse("Factory is unavailable.", 404);

    const { data, error } = await createSupabaseAdminClient().rpc("preview_factory_model_routing", {
      p_workspace_id: workspace.id,
      p_factory_id: factory.data.id,
      p_actor_user_id: user.id,
      p_expected_activation_number: preview.data.expectedActivationNumber,
      p_draft_id: preview.data.draftId,
      p_task_class_slug: preview.data.taskClassSlug,
    });
    switch (error?.code) {
      case "PT409":
        return errorResponse(
          "The active definition or draft changed. Reload before previewing.",
          409,
        );
      case "42501":
        return errorResponse("Active factory manager access is required.", 403);
      case "P0002":
        return errorResponse("The saved draft is unavailable.", 404);
    }
    if (error) throw error;

    const result = routingPreviewResponseSchema.parse(data);
    if (result.draftId !== preview.data.draftId) {
      return errorResponse("The routing preview did not match the saved draft.", 409);
    }
    return Response.json(result, { headers });
  } catch {
    return errorResponse("Could not preview model routing.", 500);
  }
}
