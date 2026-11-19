import { z } from "zod";

import { FactoryAuditCursorError, readFactoryAuditPage } from "@/lib/factories/audit";
import {
  factoryAuditCursorTokenSchema,
  factoryAuditFacetSchema,
  factoryAuditSourceSchema,
} from "@/lib/factories/audit-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";

type RouteContext = { params: Promise<{ factoryId: string; workspaceId: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: factoryAuditCursorTokenSchema.optional(),
  facet: factoryAuditFacetSchema.optional(),
});

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request, { params }: RouteContext) {
  const search = Object.fromEntries(new URL(request.url).searchParams);
  const query = querySchema.safeParse(search);
  const source = factoryAuditSourceSchema
    .optional()
    .safeParse(
      search.sourceKind !== undefined || search.sourceId !== undefined
        ? { kind: search.sourceKind, id: search.sourceId }
        : undefined,
    );
  if (!query.success || !source.success)
    return errorResponse("Invalid audit history request.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const { workspaceId, factoryId, access } = context;
    const { supabase, currentMember } = access;
    if (currentMember.role !== "owner" && currentMember.role !== "admin") {
      const membership = await supabase
        .from("factory_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("member_id", currentMember.id)
        .is("revoked_at", null)
        .maybeSingle();
      if (membership.error) throw membership.error;
      if (membership.data?.role !== "manager") {
        return errorResponse("Factory manager access is required to read the audit history.", 403);
      }
    }

    const page = await readFactoryAuditPage(supabase, workspaceId, factoryId, {
      ...query.data,
      source: source.data,
    });
    return Response.json(page, { headers });
  } catch (error) {
    if (error instanceof FactoryAuditCursorError) return errorResponse(error.message, 400);
    return errorResponse("Could not load factory audit history.", 500);
  }
}
