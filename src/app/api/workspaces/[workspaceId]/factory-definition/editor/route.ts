import { z } from "zod";

import {
  loadFactoryEditorDocument,
  loadFactoryEditorSnapshot,
  previewFactoryEditorDefinition,
} from "@/lib/factory-definitions/editor";
import { factoryEditorPreviewRequestSchema } from "@/lib/factory-definitions/editor-contracts";
import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import type { FactoryDefinitionTarget } from "@/lib/factory-definitions/storage";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const headers = { "Cache-Control": "private, no-store" };
const querySchema = z
  .object({ revisionId: z.string().uuid().optional(), draftId: z.string().uuid().optional() })
  .strict()
  .refine(({ revisionId, draftId }) => !(revisionId && draftId));

function respond(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

export async function GET(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  const query = new URL(request.url).searchParams;
  const selection = querySchema.safeParse(Object.fromEntries(query));
  if (!workspace.success || !selection.success || query.size > 1) {
    return respond({ error: "Invalid factory definition editor request." }, 400);
  }

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);
    const { workspace: authorized, supabase } = access.context;
    const { draftId, revisionId } = selection.data;
    const target: FactoryDefinitionTarget | null = draftId
      ? { kind: "draft", id: draftId }
      : revisionId
        ? { kind: "revision", id: revisionId }
        : null;
    if (target) {
      const document = await loadFactoryEditorDocument(
        supabase,
        authorized.id,
        target,
        workspace.data.factoryId,
      );
      return document
        ? respond({ document })
        : respond({ error: "Factory definition record not found." }, 404);
    }

    const snapshot = await loadFactoryEditorSnapshot(
      supabase,
      authorized.id,
      workspace.data.factoryId,
    );
    return snapshot
      ? respond({ snapshot })
      : respond(
          {
            error: workspace.data.factoryId
              ? "Selected factory unavailable."
              : "Default factory not found.",
          },
          404,
        );
  } catch {
    return respond({ error: "Could not load the factory definition editor." }, 500);
  }
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!workspace.success) return respond({ error: "Invalid workspace id." }, 400);

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return respond({ error: body.message }, 400);
    const command = factoryEditorPreviewRequestSchema.safeParse(body.value);
    if (!command.success) {
      return respond({ error: "Invalid factory definition preview request." }, 400);
    }
    const { workspace: authorized, supabase } = access.context;
    const result = await previewFactoryEditorDefinition(
      supabase,
      authorized.id,
      command.data,
      workspace.data.factoryId,
    );
    return result.ok
      ? respond({ content: result.content })
      : respond({ error: result.error, diagnostics: result.diagnostics }, result.status);
  } catch {
    return respond({ error: "Could not preview the factory definition." }, 500);
  }
}
