import { z } from "zod";

import {
  FACTORY_SLUG_CHANGED,
  FACTORY_SLUG_TAKEN,
  FACTORY_SLUG_TAKEN_MESSAGE,
} from "@/lib/factories/contracts";
import {
  archiveAdditionalFactory,
  factoryErrorStatus,
  factoryManagementCommandSchema,
  renameFactory,
  restoreFactory,
  setFactorySlug,
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

  const command = factoryManagementCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return errorResponse("Use a rename, set-slug, archive, or restore command.", 400);
  }

  try {
    const admin = createSupabaseAdminClient();
    const input = { actorUserId: access.context.user.id, factoryId, workspaceId };
    switch (command.data.action) {
      case "archive":
        return Response.json(
          {
            factory: await archiveAdditionalFactory(admin, {
              ...input,
              reason: command.data.reason ?? null,
            }),
          },
          { headers },
        );
      case "restore":
        return Response.json({ factory: await restoreFactory(admin, input) }, { headers });
      case "rename":
        return Response.json(
          {
            factory: await renameFactory(admin, {
              ...input,
              expectedName: command.data.expectedName,
              name: command.data.name,
            }),
          },
          { headers },
        );
      case "set-slug":
        return Response.json(
          {
            factory: await setFactorySlug(admin, {
              ...input,
              expectedSlug: command.data.expectedSlug,
              slug: command.data.slug,
            }),
          },
          { headers },
        );
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    const action = command.data.action;
    const status = factoryErrorStatus(code);
    if (action === "set-slug") {
      if (code === "23505" || code === "PT409") {
        return Response.json(
          code === "23505"
            ? { code: FACTORY_SLUG_TAKEN, error: FACTORY_SLUG_TAKEN_MESSAGE }
            : {
                code: FACTORY_SLUG_CHANGED,
                error: "The factory slug changed. Reload and try again.",
              },
          { status, headers },
        );
      }
      if (code === "P0011") {
        return errorResponse("Restore the factory before editing its slug.", status);
      }
      return errorResponse("Could not save the factory slug.", status);
    }
    if (code === "PT409" && action === "rename") {
      return errorResponse("The factory name changed. Reload and try again.", status);
    }
    if (code === "PT409") {
      return errorResponse("The factory is already in the requested state.", status);
    }
    if (code === "23514" && action === "archive") {
      return errorResponse("The workspace default factory cannot be archived.", status);
    }
    if (code === "P0011" && action === "rename") {
      return errorResponse("Restore the factory before renaming it.", status);
    }
    return errorResponse(`Could not ${action} the factory.`, status);
  }
}
