import { NextResponse } from "next/server";
import { z } from "zod";

import {
  type WorkspaceOnboardingData,
  loadWorkspaceOnboardingData,
  updateWorkspaceOnboardingData,
} from "@/features/onboarding/data";
import { workspaceOnboardingUpdatePayloadSchema } from "@/lib/onboarding/contracts";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const workspaceIdParamSchema = z.string().uuid("Workspace id must be a valid UUID.");

function onboardingResponse(data: WorkspaceOnboardingData) {
  return {
    agentConfig: data.agentConfig,
    canManage: data.canManage,
    currentMember: data.currentMember,
    github: data.github,
    linearRouting: data.linearRouting,
    linearSecret: data.linearSecret,
    onboarding: data.onboarding,
    pipeline: data.pipeline,
    setupHealth: data.setupHealth,
    workspace: data.workspace,
    workspaceMembers: data.workspaceMembers,
    workspaceSecrets: data.workspaceSecrets,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdParamSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      { error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id." },
      { status: 400 },
    );
  }

  const result = await loadWorkspaceOnboardingData(parsedWorkspaceId.data);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(onboardingResponse(result.data), { status: 200 });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdParamSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      { error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = workspaceOnboardingUpdatePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid onboarding payload." },
      { status: 400 },
    );
  }

  try {
    const result = await updateWorkspaceOnboardingData(parsedWorkspaceId.data, parsed.data);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(onboardingResponse(result.data), { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid onboarding state." },
        { status: 500 },
      );
    }

    throw error;
  }
}
