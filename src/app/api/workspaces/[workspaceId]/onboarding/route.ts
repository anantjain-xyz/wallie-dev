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

function onboardingResponse(data: WorkspaceOnboardingData) {
  return {
    canManage: data.canManage,
    currentMember: data.currentMember,
    onboarding: data.onboarding,
    setupHealth: data.setupHealth,
    workspace: data.workspace,
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const result = await loadWorkspaceOnboardingData(workspaceId);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(onboardingResponse(result.data), { status: 200 });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;

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
    const result = await updateWorkspaceOnboardingData(workspaceId, parsed.data);

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
