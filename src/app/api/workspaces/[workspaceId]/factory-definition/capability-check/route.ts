import { after } from "next/server";
import { z } from "zod";

import {
  readFactoryDefinitionCapabilityCheck,
  startFactoryDefinitionCapabilityCheck,
} from "@/lib/factory-definitions/capability-checks";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };
const idSchema = z.string().uuid();
const targetQuerySchema = z.union([
  z
    .object({ draftId: idSchema })
    .strict()
    .transform(({ draftId }) => ({ kind: "draft" as const, id: draftId })),
  z
    .object({ revisionId: idSchema })
    .strict()
    .transform(({ revisionId }) => ({ kind: "revision" as const, id: revisionId })),
]);
const requestSchema = z
  .object({
    target: z.object({ kind: z.enum(["draft", "revision"]), id: idSchema }).strict(),
  })
  .strict();

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request, { params }: RouteContext) {
  const workspaceId = idSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
    if (!access.ok) return errorResponse(access.error, access.status);

    const search = new URL(request.url).searchParams;
    const target = targetQuerySchema.safeParse(Object.fromEntries(search));
    if (search.size !== 1 || !target.success) {
      return errorResponse("Specify one draftId or revisionId for the capability check.", 400);
    }
    const result = await readFactoryDefinitionCapabilityCheck({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      target: target.data,
    });
    if (!result.ok) {
      return Response.json(
        { error: result.error, diagnostics: result.diagnostics },
        { status: result.status, headers },
      );
    }
    return Response.json({ check: result.check }, { headers });
  } catch {
    return errorResponse("Could not load the factory definition capability check.", 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const workspaceId = idSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
    if (!access.ok) return errorResponse(access.error, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return errorResponse(body.message, 400);
    const parsed = requestSchema.safeParse(body.value);
    if (!parsed.success)
      return errorResponse("Invalid factory definition capability check request.", 400);

    const result = await startFactoryDefinitionCapabilityCheck({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      actorUserId: access.context.user.id,
      target: parsed.data.target,
    });
    if (!result.ok) {
      return Response.json(
        { error: result.error, diagnostics: result.diagnostics },
        { status: result.status, headers },
      );
    }

    after(async () => {
      await result.complete();
    });
    return Response.json({ check: result.check }, { status: 202, headers });
  } catch {
    return errorResponse("Could not start the factory definition capability check.", 500);
  }
}
