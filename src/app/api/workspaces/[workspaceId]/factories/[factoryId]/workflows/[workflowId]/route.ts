import { z } from "zod";

import { mutateWorkflowAuthoring, readWorkflowAuthoring } from "@/lib/factory-workflows/authoring";
import {
  workflowAuthoringCommandSchema,
  workflowAuthoringPathSchema,
  workflowReferenceQuerySchema,
} from "@/lib/factory-workflows/authoring-contracts";
import {
  readWorkflowAuthoringCommand,
  workflowAuthoringError,
  workflowAuthoringResponse,
} from "@/lib/factory-workflows/authoring-http";
import {
  loadWorkflowEditorChoices,
  loadWorkflowReferencePage,
} from "@/lib/factory-workflows/reference-catalog";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string; workflowId: string }> };
const draftIdSchema = z.string().uuid().toLowerCase().optional();
const querySchema = z.union([
  z.strictObject({ draftId: draftIdSchema }),
  z.strictObject({ draftId: draftIdSchema, includeChoices: z.literal("true") }),
  workflowReferenceQuerySchema,
]);

export async function GET(request: Request, { params }: Context) {
  const ids = workflowAuthoringPathSchema.safeParse(await params);
  const query = new URL(request.url).searchParams;
  const selection = querySchema.safeParse(Object.fromEntries(query));
  if (!ids.success || !selection.success || query.size !== new Set(query.keys()).size) {
    return workflowAuthoringResponse({ error: "Invalid workflow configuration request." }, 400);
  }
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(ids.data));
    if (!context.ok) return context.response;
    const scope = { ...ids.data, supabase: context.access.supabase };
    const snapshot = await readWorkflowAuthoring(
      scope.supabase,
      ids.data,
      "draftId" in selection.data ? selection.data.draftId : undefined,
    );
    if (!snapshot) return workflowAuthoringResponse({ error: "Workflow draft not found." }, 404);
    if ("catalog" in selection.data) {
      if (
        selection.data.catalog === "writers" &&
        selection.data.baseActivationId !== snapshot.baseDefinition?.activationId
      ) {
        return workflowAuthoringResponse(
          { error: "The active base definition changed. Load the current draft." },
          409,
        );
      }
      return workflowAuthoringResponse(
        await loadWorkflowReferencePage(scope, selection.data, snapshot.baseDefinition),
      );
    }
    if ("includeChoices" in selection.data) {
      const choices = await loadWorkflowEditorChoices(scope, snapshot.baseDefinition);
      return workflowAuthoringResponse({ snapshot, choices });
    }
    return workflowAuthoringResponse(snapshot);
  } catch (error) {
    return workflowAuthoringError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const ids = workflowAuthoringPathSchema.safeParse(await params);
  if (!ids.success) return workflowAuthoringResponse({ error: "Invalid workflow identity." }, 400);
  try {
    const context = await resolveFactoryRouteContext(Promise.resolve(ids.data));
    if (!context.ok) return context.response;
    const command = workflowAuthoringCommandSchema.safeParse(
      await readWorkflowAuthoringCommand(request),
    );
    if (!command.success)
      return workflowAuthoringResponse({ error: "Provide an exact workflow draft command." }, 400);
    const result = await mutateWorkflowAuthoring(
      context.access.supabase,
      createSupabaseAdminClient,
      {
        ...ids.data,
        actorUserId: context.access.user.id,
      },
      command.data,
    );
    return result.ok
      ? workflowAuthoringResponse(result)
      : workflowAuthoringResponse(result, result.status);
  } catch (error) {
    return workflowAuthoringError(error);
  }
}
