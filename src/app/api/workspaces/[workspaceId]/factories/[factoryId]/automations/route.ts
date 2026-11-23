import {
  createFactoryAutomationSchema,
  factoryAutomationListQuerySchema,
} from "@/lib/factory-automations/contracts";
import {
  automationError,
  automationResponse,
  readAutomationCommand,
} from "@/lib/factory-automations/http";
import { createFactoryAutomation, listFactoryAutomations } from "@/lib/factory-automations/service";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function GET(request: Request, { params }: Context) {
  const query = new URL(request.url).searchParams;
  const selection = factoryAutomationListQuerySchema.safeParse(Object.fromEntries(query));
  if (!selection.success || query.getAll("afterId").length > 1) {
    return automationResponse({ error: "Provide a valid automation list cursor." }, 400);
  }
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const result = await listFactoryAutomations(
      context.access.supabase,
      context,
      selection.data.afterId,
    );
    return result
      ? automationResponse(result)
      : automationResponse({ error: "Automations are unavailable." }, 404);
  } catch (error) {
    return automationError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const input = await readAutomationCommand(request, createFactoryAutomationSchema);
    if (!input.ok) return input.response;
    const automation = await createFactoryAutomation(
      createSupabaseAdminClient(),
      {
        workspaceId: context.workspaceId,
        factoryId: context.factoryId,
        actorUserId: context.access.user.id,
      },
      input.command,
    );
    return automationResponse({ automation }, 201);
  } catch (error) {
    return automationError(error);
  }
}
