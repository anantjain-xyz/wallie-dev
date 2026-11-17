import { z } from "zod";

import { listFactoryAuditEvents } from "@/lib/factories/scope";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ factoryId: string; workspaceId: string }> };

const headers = { "Cache-Control": "private, no-store" };
const uuidSchema = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request, { params }: RouteContext) {
  const { factoryId, workspaceId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success || !uuidSchema.safeParse(factoryId).success) {
    return errorResponse("Invalid factory id.", 400);
  }

  const limit = limitSchema.safeParse(new URL(request.url).searchParams.get("limit") ?? undefined);
  if (!limit.success) return errorResponse("Invalid audit limit.", 400);

  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return errorResponse(access.error, access.status);

  try {
    const events = await listFactoryAuditEvents(
      access.context.supabase,
      workspaceId,
      factoryId,
      limit.data,
    );
    return Response.json({ events }, { headers });
  } catch {
    return errorResponse("Could not load factory audit history.", 500);
  }
}
