import { z } from "zod";

import {
  archiveFactory,
  factoryErrorStatus,
  factoryStatusCommandSchema,
  restoreFactory,
} from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ factoryId: string; workspaceId: string }> };

const headers = { "Cache-Control": "private, no-store" };
const uuidSchema = z.string().uuid();

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { factoryId, workspaceId } = await params;
  if (!uuidSchema.safeParse(workspaceId).success || !uuidSchema.safeParse(factoryId).success) {
    return errorResponse("Invalid factory id.", 400);
  }

  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return errorResponse(access.error, access.status);

  const command = factoryStatusCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return errorResponse("Use an archive or restore command.", 400);
  }

  try {
    const admin = createSupabaseAdminClient();
    const factory =
      command.data.action === "archive"
        ? await archiveFactory(admin, {
            workspaceId,
            factoryId,
            actorUserId: access.context.user.id,
            reason: command.data.reason ?? null,
          })
        : await restoreFactory(admin, {
            workspaceId,
            factoryId,
            actorUserId: access.context.user.id,
          });
    return Response.json({ factory }, { headers });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return errorResponse(
      code === "PT409"
        ? "The factory is already in the requested state."
        : command.data.action === "archive"
          ? "Could not archive the factory."
          : "Could not restore the factory.",
      factoryErrorStatus(code),
    );
  }
}
