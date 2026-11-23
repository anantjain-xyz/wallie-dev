import {
  factoryAutomationCommandSchema,
  factoryAutomationPathSchema,
  factoryAutomationReadQuerySchema,
} from "@/lib/factory-automations/contracts";
import {
  automationError,
  automationResponse,
  readAutomationCommand,
} from "@/lib/factory-automations/http";
import { mutateFactoryAutomation, readFactoryAutomation } from "@/lib/factory-automations/service";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = {
  params: Promise<{ workspaceId: string; factoryId: string; automationId: string }>;
};

export async function GET(request: Request, { params }: Context) {
  const path = factoryAutomationPathSchema.safeParse(await params);
  if (!path.success) return automationResponse({ error: "Provide a valid automation ID." }, 400);
  const query = new URL(request.url).searchParams;
  const selection = factoryAutomationReadQuerySchema.safeParse(Object.fromEntries(query));
  if (!selection.success || query.getAll("revisionId").length > 1) {
    return automationResponse({ error: "Provide a valid automation revision ID." }, 400);
  }
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(path.data));
    if (!context.ok) return context.response;
    const automation = await readFactoryAutomation(
      context.access.supabase,
      path.data,
      selection.data,
    );
    return automation
      ? automationResponse({ automation })
      : automationResponse({ error: "Automation not found." }, 404);
  } catch (error) {
    return automationError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const path = factoryAutomationPathSchema.safeParse(await params);
  if (!path.success) return automationResponse({ error: "Provide a valid automation ID." }, 400);
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(path.data));
    if (!context.ok) return context.response;
    const input = await readAutomationCommand(request, factoryAutomationCommandSchema);
    if (!input.ok) return input.response;
    const automation = await mutateFactoryAutomation(
      createSupabaseAdminClient(),
      { ...path.data, actorUserId: context.access.user.id },
      input.command,
    );
    return automationResponse({ automation });
  } catch (error) {
    return automationError(error);
  }
}
