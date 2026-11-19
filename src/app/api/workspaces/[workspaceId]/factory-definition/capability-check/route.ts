import { after } from "next/server";
import { z } from "zod";

import {
  readFactoryDefinitionCapabilityCheck,
  startFactoryDefinitionCapabilityCheck,
} from "@/lib/factory-definitions/capability-checks";
import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const headers = { "Cache-Control": "private, no-store" };
const idSchema = z.string().uuid();
const repositoryIdSchema = idSchema.transform((id) => id.toLowerCase()).optional();
const targetQuerySchema = z.union([
  z
    .object({ draftId: idSchema, repositoryId: repositoryIdSchema })
    .strict()
    .transform(({ draftId, repositoryId }) => ({
      target: { kind: "draft" as const, id: draftId },
      ...(repositoryId ? { repositoryId } : {}),
    })),
  z
    .object({ revisionId: idSchema, repositoryId: repositoryIdSchema })
    .strict()
    .transform(({ revisionId, repositoryId }) => ({
      target: { kind: "revision" as const, id: revisionId },
      ...(repositoryId ? { repositoryId } : {}),
    })),
]);
const requestSchema = z
  .object({
    target: z.object({ kind: z.enum(["draft", "revision"]), id: idSchema }).strict(),
    repositoryId: repositoryIdSchema,
  })
  .strict();

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!workspace.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return errorResponse(access.error, access.status);

    const search = new URL(request.url).searchParams;
    const target = targetQuerySchema.safeParse(Object.fromEntries(search));
    if (search.size !== new Set(search.keys()).size || !target.success) {
      return errorResponse("Specify one draftId or revisionId for the capability check.", 400);
    }
    const result = await readFactoryDefinitionCapabilityCheck({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      ...(workspace.data.factoryId ? { factoryId: workspace.data.factoryId } : {}),
      ...target.data,
    });
    if (!result.ok) return errorResponse(result.error, result.status);
    return Response.json({ check: result.check }, { headers });
  } catch {
    return errorResponse("Could not load the factory definition capability check.", 500);
  }
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!workspace.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return errorResponse(access.error, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return errorResponse(body.message, 400);
    const parsed = requestSchema.safeParse(body.value);
    if (!parsed.success)
      return errorResponse("Invalid factory definition capability check request.", 400);

    const result = await startFactoryDefinitionCapabilityCheck({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      ...(workspace.data.factoryId ? { factoryId: workspace.data.factoryId } : {}),
      actorUserId: access.context.user.id,
      ...parsed.data,
    });
    if (!result.ok) return errorResponse(result.error, result.status);

    after(async () => {
      await result.complete();
    });
    return Response.json({ check: result.check }, { status: 202, headers });
  } catch {
    return errorResponse("Could not start the factory definition capability check.", 500);
  }
}
