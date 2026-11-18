import {
  createServicePrincipalSchema,
  factoryExecutionAuthorityPageSchema,
  isFactoryExecutionAuthorityJsonRequest,
} from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

const principalColumns =
  "id, workspace_id, factory_id, name, slug, created_by_member_id, created_at";

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const query = factoryExecutionAuthorityPageSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return Response.json(
      { error: "Invalid service principal list request." },
      { status: 400, headers },
    );
  }

  const { afterId, limit } = query.data;
  let page = context.access.supabase
    .from("service_principals")
    .select(principalColumns)
    .eq("workspace_id", context.workspaceId)
    .eq("factory_id", context.factoryId)
    .order("id")
    .limit(limit + 1);
  if (afterId) page = page.gt("id", afterId);
  const { data, error } = await page;
  if (error) {
    return Response.json({ error: "Could not load service principals." }, { status: 500, headers });
  }
  const principals = data.slice(0, limit);
  return Response.json(
    { principals, nextAfterId: data.length > limit ? principals.at(-1)?.id : null },
    { headers },
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = createServicePrincipalSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return Response.json(
      { error: "Provide a service principal name and slug." },
      { status: 400, headers },
    );
  }

  const { data: principal, error } = await createSupabaseAdminClient()
    .rpc("create_service_principal", {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
      p_name: command.data.name,
      p_slug: command.data.slug,
    })
    .select(principalColumns)
    .single();
  if (error || !principal) {
    return Response.json(
      { error: "Could not create the service principal." },
      { status: factoryErrorStatus(error?.code), headers },
    );
  }
  return Response.json({ principal }, { status: 201, headers });
}
