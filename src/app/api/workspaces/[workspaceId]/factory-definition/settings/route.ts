import { z } from "zod";

import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { settingsFactoryCommandSchema } from "@/lib/factory-definitions/settings-command-schema";
import {
  archivedStageIdsForDefinition,
  loadFactoryDefinitionHistoryForStages,
  loadPipelineConfigurationForFactoryDefinition,
  loadSettingsFactoryDefinitionState,
  mutateSettingsFactoryDefinition,
} from "@/lib/factory-definitions/settings";
import {
  agentConfigFromFactoryDefinition,
  mapCompilerDiagnosticsToAgentFieldErrors,
  pipelineFromFactoryDefinition,
} from "@/lib/factory-definitions/settings-projection";
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

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data);
    if (!access.ok) return errorResponse(access.error, access.status);
    const { supabase, workspace } = access.context;

    const state = await loadSettingsFactoryDefinitionState(supabase, workspace.id);
    const livePipeline = await loadPipelineConfigurationForFactoryDefinition(
      supabase,
      workspace.id,
      state.activeDefinition?.pipelineId,
    );

    const priorDefinitions =
      state.activeDefinition && livePipeline
        ? await loadFactoryDefinitionHistoryForStages(supabase, workspace.id, state, [], {
            requiredStageIds: archivedStageIdsForDefinition(livePipeline, state.activeDefinition),
          })
        : [];

    const pipeline =
      state.activeDefinition && livePipeline
        ? pipelineFromFactoryDefinition(livePipeline, state.activeDefinition, priorDefinitions)
        : livePipeline;

    return Response.json(
      {
        state,
        pipeline,
        ...(state.activeDefinition
          ? {
              agentConfig: agentConfigFromFactoryDefinition(state.activeDefinition),
              sandboxProvider: state.activeDefinition.sandboxProvider,
            }
          : {}),
      },
      { headers },
    );
  } catch {
    return errorResponse("Could not load factory definition settings.", 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const workspaceId = workspaceIdSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
    if (!access.ok) return errorResponse(access.error, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return errorResponse(body.message, 400);

    const command = settingsFactoryCommandSchema.safeParse(body.value);
    if (!command.success) {
      return errorResponse(
        command.error.issues[0]?.message ?? "Invalid factory definition settings command.",
        400,
      );
    }

    const result = await mutateSettingsFactoryDefinition({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      actorUserId: access.context.user.id,
      command: command.data,
    });
    if (!result.ok) {
      const fieldErrors = mapCompilerDiagnosticsToAgentFieldErrors(result.diagnostics);
      return Response.json(
        {
          error: result.error,
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
          ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
        },
        { status: result.status, headers },
      );
    }

    return Response.json(result.result, { status: 201, headers });
  } catch {
    return errorResponse("Could not update the factory definition.", 500);
  }
}
