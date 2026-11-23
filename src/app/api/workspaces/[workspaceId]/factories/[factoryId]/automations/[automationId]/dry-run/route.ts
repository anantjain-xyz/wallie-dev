import { factoryAutomationPathSchema } from "@/lib/factory-automations/contracts";
import { automationDryRunRequestSchema } from "@/lib/factory-automations/dry-run-contracts";
import {
  automationError,
  automationResponse,
  readAutomationCommand,
} from "@/lib/factory-automations/http";
import { dryRunFactoryAutomation } from "@/lib/factory-automations/service";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";

type Context = {
  params: Promise<{ workspaceId: string; factoryId: string; automationId: string }>;
};

export async function POST(request: Request, { params }: Context) {
  const path = factoryAutomationPathSchema.safeParse(await params);
  if (!path.success) return automationResponse({ error: "Provide a valid automation ID." }, 400);
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(path.data));
    if (!context.ok) return context.response;
    const input = await readAutomationCommand(request, automationDryRunRequestSchema);
    if (!input.ok) return input.response;
    const result = await dryRunFactoryAutomation(context.access.supabase, path.data, input.command);
    return result
      ? automationResponse(result)
      : automationResponse({ error: "Automation revision not found." }, 404);
  } catch (error) {
    return automationError(error);
  }
}
