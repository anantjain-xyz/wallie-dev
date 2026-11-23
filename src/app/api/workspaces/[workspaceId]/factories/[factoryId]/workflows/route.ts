import { z } from "zod";

import { createWorkflowAuthoring, listWorkflowAuthoring } from "@/lib/factory-workflows/authoring";
import { createWorkflowAuthoringSchema } from "@/lib/factory-workflows/authoring-contracts";
import {
  readWorkflowAuthoringCommand,
  workflowAuthoringError,
  workflowAuthoringResponse,
} from "@/lib/factory-workflows/authoring-http";
import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };
const querySchema = z.strictObject({ afterId: z.string().uuid().toLowerCase().optional() });

export async function GET(request: Request, { params }: Context) {
  const query = new URL(request.url).searchParams;
  const selection = querySchema.safeParse(Object.fromEntries(query));
  if (!selection.success || query.size !== new Set(query.keys()).size) {
    return workflowAuthoringResponse({ error: "Invalid workflow list request." }, 400);
  }
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const result = await listWorkflowAuthoring(
      context.access.supabase,
      context,
      selection.data.afterId,
    );
    return result
      ? workflowAuthoringResponse(result)
      : workflowAuthoringResponse({ error: "Workflow configuration unavailable." }, 404);
  } catch (error) {
    return workflowAuthoringError(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const command = createWorkflowAuthoringSchema.safeParse(
      await readWorkflowAuthoringCommand(request),
    );
    if (!command.success)
      return workflowAuthoringResponse({ error: "Provide a workflow ID and name." }, 400);
    const workflow = await createWorkflowAuthoring(
      createSupabaseAdminClient(),
      {
        workspaceId: context.workspaceId,
        factoryId: context.factoryId,
        actorUserId: context.access.user.id,
        workflowId: command.data.workflowId,
      },
      command.data.displayName,
    );
    return workflowAuthoringResponse({ workflow }, 201);
  } catch (error) {
    return workflowAuthoringError(error);
  }
}
