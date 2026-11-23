import { z } from "zod";

import { mutateWorkflowAuthoring, readWorkflowAuthoring } from "@/lib/factory-workflows/authoring";
import {
  workflowAuthoringCommandSchema,
  workflowAuthoringPathSchema,
} from "@/lib/factory-workflows/authoring-contracts";
import {
  readWorkflowAuthoringCommand,
  workflowAuthoringError,
  workflowAuthoringResponse,
} from "@/lib/factory-workflows/authoring-http";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string; workflowId: string }> };
const querySchema = z.strictObject({ draftId: z.string().uuid().toLowerCase().optional() });

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
    const snapshot = await readWorkflowAuthoring(
      context.access.supabase,
      ids.data,
      selection.data.draftId,
    );
    return snapshot
      ? workflowAuthoringResponse(snapshot)
      : workflowAuthoringResponse({ error: "Workflow draft not found." }, 404);
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
