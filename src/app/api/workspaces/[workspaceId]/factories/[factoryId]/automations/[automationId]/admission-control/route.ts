import { automationAdmissionControlCommandSchema } from "@/lib/factory-automations/admission-control-contracts";
import { factoryAutomationPathSchema } from "@/lib/factory-automations/contracts";
import {
  automationError,
  automationResponse,
  readAutomationCommand,
} from "@/lib/factory-automations/http";
import {
  configureAutomationAdmission,
  readAutomationAdmissionControl,
} from "@/lib/factory-automations/service";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = {
  params: Promise<{ workspaceId: string; factoryId: string; automationId: string }>;
};

export async function GET(_request: Request, { params }: Context) {
  const path = factoryAutomationPathSchema.safeParse(await params);
  if (!path.success) return automationResponse({ error: "Provide a valid automation ID." }, 400);
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(path.data));
    if (!context.ok) return context.response;
    const control = await readAutomationAdmissionControl(context.access.supabase, path.data);
    return control
      ? automationResponse({ control })
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
    const input = await readAutomationCommand(request, automationAdmissionControlCommandSchema);
    if (!input.ok) return input.response;
    const control = await configureAutomationAdmission(
      createSupabaseAdminClient(),
      { ...path.data, actorUserId: context.access.user.id },
      input.command,
    );
    return automationResponse({ control });
  } catch (error) {
    return automationError(error);
  }
}
