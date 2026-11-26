import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { loadNamedFactoryReferences } from "@/lib/factory-definitions/named-reference-catalog";
import { namedReferencesRequestSchema } from "@/lib/factory-definitions/named-reference-contracts";
import { selectFactory } from "@/lib/factory-definitions/storage";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const headers = { "Cache-Control": "private, no-store" };

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const parsed = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!parsed.success || !parsed.data.factoryId) return respond({ error: "Invalid factory." }, 400);
  const { workspaceId, factoryId } = parsed.data;
  try {
    const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const { supabase } = access.context;
    const factory = await selectFactory(supabase, workspaceId, factoryId);
    if (factory.error) throw factory.error;
    if (!factory.data) return respond({ error: "Factory unavailable." }, 404);
    const body = await request.text();
    const query = namedReferencesRequestSchema.safeParse(
      body.length <= 900_000 ? (JSON.parse(body) as unknown) : null,
    );
    if (!query.success) return respond({ error: "Invalid reference lookup." }, 400);
    return respond(await loadNamedFactoryReferences(supabase, workspaceId, factoryId, query.data));
  } catch (error) {
    if (error instanceof SyntaxError) return respond({ error: "Invalid reference lookup." }, 400);
    return respond({ error: "Could not load named references." }, 500);
  }
}
