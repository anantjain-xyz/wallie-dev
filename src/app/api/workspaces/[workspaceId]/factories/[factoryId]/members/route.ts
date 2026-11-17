import { z } from "zod";

import {
  factoryErrorStatus,
  grantFactoryMembership,
  grantFactoryMembershipSchema,
  revokeFactoryMembership,
  revokeFactoryMembershipSchema,
} from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById, type WorkspaceAccessContext } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ factoryId: string; workspaceId: string }> };
type ResolvedContext =
  | { ok: false; response: Response }
  | {
      ok: true;
      access: { context: WorkspaceAccessContext };
      factoryId: string;
      workspaceId: string;
    };

const headers = { "Cache-Control": "private, no-store" };
const uuidSchema = z.string().uuid();

function errorResponse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers });
}

async function resolveContext(params: RouteContext["params"]): Promise<ResolvedContext> {
  const { factoryId, workspaceId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success || !uuidSchema.safeParse(factoryId).success) {
    return { ok: false, response: errorResponse("Invalid factory id.", 400) };
  }
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return { ok: false, response: errorResponse(access.error, access.status) };
  return { access, factoryId, ok: true, workspaceId };
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const context = await resolveContext(params);
  if (!context.ok) return context.response;

  const body = grantFactoryMembershipSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return errorResponse("Provide a workspace member id and a manager or member role.", 400);
  }

  try {
    const membership = await grantFactoryMembership(createSupabaseAdminClient(), {
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId: context.access.context.user.id,
      memberId: body.data.memberId,
      role: body.data.role,
    });
    return Response.json({ membership }, { status: 201, headers });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return errorResponse(
      code === "P0011"
        ? "Restore the archived factory before granting membership."
        : "Could not grant factory membership.",
      factoryErrorStatus(code),
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext): Promise<Response> {
  const context = await resolveContext(params);
  if (!context.ok) return context.response;

  const body = revokeFactoryMembershipSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return errorResponse("Provide a workspace member id.", 400);

  try {
    const membership = await revokeFactoryMembership(createSupabaseAdminClient(), {
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId: context.access.context.user.id,
      memberId: body.data.memberId,
      reason: body.data.reason ?? null,
    });
    return Response.json({ membership }, { headers });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return errorResponse(
      code === "23514"
        ? "A factory must retain at least one manager."
        : "Could not revoke factory membership.",
      factoryErrorStatus(code),
    );
  }
}
