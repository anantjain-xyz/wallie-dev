import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { loadFactorySettings, mutateFactorySettings } from "@/lib/factory-definitions/settings";
import { factorySettingsCommandSchema } from "@/lib/factory-definitions/settings-contracts";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

export async function GET(_request: Request, { params }: RouteContext) {
  const parsed = workspaceIdParamsSchema.safeParse(await params);
  if (!parsed.success) return respond({ error: "Invalid workspace id." }, 400);

  try {
    const access = await requireWorkspaceAccessById(parsed.data.workspaceId);
    if (!access.ok) return respond({ error: access.error }, access.status);
    const { currentMember, supabase, workspace } = access.context;
    const snapshot = await loadFactorySettings(
      supabase,
      workspace.id,
      currentMember.role === "owner" || currentMember.role === "admin",
    );
    return respond({ snapshot });
  } catch {
    return respond({ error: "Could not load the factory configuration." }, 500);
  }
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const parsed = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!parsed.success) return respond({ error: "Invalid workspace id." }, 400);

  try {
    const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return respond({ error: body.message }, 400);
    const command = factorySettingsCommandSchema.safeParse(body.value);
    if (!command.success) {
      return respond(
        { error: command.error.issues[0]?.message ?? "Invalid factory configuration command." },
        400,
      );
    }

    const result = await mutateFactorySettings({
      client: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      ...(parsed.data.factoryId ? { factoryId: parsed.data.factoryId } : {}),
      actorUserId: access.context.user.id,
      command: command.data,
    });
    return result.ok
      ? respond({ snapshot: result.snapshot })
      : respond({ error: result.error, diagnostics: result.diagnostics }, result.status);
  } catch {
    return respond({ error: "Could not update the factory configuration." }, 500);
  }
}
