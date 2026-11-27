import { z } from "zod";

import { createFactorySchema, FACTORY_SLUG_TAKEN } from "@/lib/factories/contracts";
import { createFactory, factoryErrorStatus, listFactoryScope } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

const headers = { "Cache-Control": "private, no-store" };
const workspaceIdSchema = z.string().uuid();

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(_request: Request, { params }: RouteContext) {
  const workspaceId = workspaceIdSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  const access = await requireWorkspaceAccessById(workspaceId.data);
  if (!access.ok) return errorResponse(access.error, access.status);

  try {
    const factories = await listFactoryScope(
      createSupabaseAdminClient(),
      access.context.workspace.id,
      access.context.user.id,
    );
    return Response.json({ factories }, { headers });
  } catch {
    return errorResponse("Could not load factory scope.", 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const workspaceId = workspaceIdSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
  if (!access.ok) return errorResponse(access.error, access.status);

  const body = createFactorySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return errorResponse("Provide a factory name and lowercase hyphenated slug.", 400);
  }

  try {
    const factory = await createFactory(createSupabaseAdminClient(), {
      workspaceId: access.context.workspace.id,
      actorUserId: access.context.user.id,
      name: body.data.name,
      slug: body.data.slug,
    });
    return Response.json({ factory }, { status: 201, headers });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505") {
      return Response.json(
        { code: FACTORY_SLUG_TAKEN, error: "That factory slug is already used in this workspace." },
        { status: 409, headers },
      );
    }
    return errorResponse("Could not create the factory.", factoryErrorStatus(code));
  }
}
