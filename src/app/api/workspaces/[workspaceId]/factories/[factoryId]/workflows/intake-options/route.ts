import { factoryResponseHeaders, resolveFactoryRouteContext } from "@/lib/factories/route-context";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const scope = await resolveFactoryRouteContext(params);
    if (!scope.ok) return scope.response;
    const { data, error } = await scope.access.supabase
      .rpc("list_factory_workflow_intake_options", {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
      })
      .abortSignal(request.signal);
    if (error) throw error;
    return Response.json(
      {
        options: data.map(({ workflow_id, activation_id, display_name }) => ({
          workflowId: workflow_id,
          activationId: activation_id,
          label: display_name,
        })),
      },
      { headers: factoryResponseHeaders },
    );
  } catch {
    return Response.json(
      { error: "Published workflows are unavailable." },
      {
        status: 503,
        headers: factoryResponseHeaders,
      },
    );
  }
}
