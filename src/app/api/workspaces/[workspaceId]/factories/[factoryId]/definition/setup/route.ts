import { factoryDefinitionRouteParamsSchema } from "@/lib/factory-definitions/route-params";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { factorySetupCommandSchema } from "@/lib/factory-definitions/setup-contracts";
import { selectFactory } from "@/lib/factory-definitions/storage";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };
const statusByCode = { "42501": 403, P0002: 404, PT409: 409, PT422: 422 } as const;

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(_request: Request, { params }: Context) {
  const scope = factoryDefinitionRouteParamsSchema.required().safeParse(await params);
  if (!scope.success) return respond({ error: "Invalid factory setup scope." }, 400);
  const { workspaceId, factoryId } = scope.data;
  try {
    const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const { supabase, workspace } = access.context;
    const { data: factory, error: factoryError } = await selectFactory(
      supabase,
      workspace.id,
      factoryId,
    );
    if (factoryError) throw factoryError;
    if (!factory || factory.is_default)
      return respond({ error: "Factory unavailable for setup." }, 404);
    const { data, error } = await supabase.rpc("list_factory_setup_repositories", {
      p_workspace_id: workspace.id,
      p_factory_id: factory.id,
    });
    if (error) throw error;
    return respond({
      repositories: data.map(({ id, full_name }) => ({ id, fullName: full_name })),
    });
  } catch {
    return respond({ error: "Could not load repositories available to this factory." }, 500);
  }
}

export async function POST(request: Request, { params }: Context) {
  const scope = factoryDefinitionRouteParamsSchema.required().safeParse(await params);
  if (!scope.success) return respond({ error: "Invalid factory setup scope." }, 400);
  const { workspaceId, factoryId } = scope.data;
  try {
    const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return respond({ error: body.message }, 400);
    const command = factorySetupCommandSchema.safeParse(body.value);
    if (!command.success) return respond({ error: "Invalid factory setup command." }, 400);

    const { user, workspace } = access.context;
    const { expectedActivationNumber, expectedDraftId } = command.data;
    const { data, error } = await createSupabaseAdminClient().rpc(
      "provision_factory_serial_setup",
      {
        p_workspace_id: workspace.id,
        p_factory_id: factoryId,
        p_actor_user_id: user.id,
        p_expected_activation_number: expectedActivationNumber,
        ...(expectedDraftId ? { p_expected_draft_id: expectedDraftId } : {}),
        ...(command.data.action === "assign-repository"
          ? { p_repository_id: command.data.repositoryId }
          : {}),
      },
    );
    if (error || !data) {
      const status = statusByCode[error?.code as keyof typeof statusByCode];
      return respond(
        { error: status && error ? error.message : "Could not update factory setup." },
        status ?? 500,
      );
    }
    return respond({ id: data }, 201);
  } catch {
    return respond({ error: "Could not update factory setup." }, 500);
  }
}
