import { NextResponse } from "next/server";
import { z } from "zod";

import {
  type WorkspaceOnboardingData,
  loadWorkspaceOnboardingData,
  updateWorkspaceOnboardingData,
} from "@/features/onboarding/data";
import {
  type OnboardingValidationError,
  type WorkspaceOnboardingMutationErrorResponse,
  workspaceOnboardingMutationRequestSchema,
} from "@/lib/onboarding/contracts";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const workspaceIdParamSchema = z.string().uuid("Workspace id must be a valid UUID.");

function mutationErrorResponse(input: {
  action?: WorkspaceOnboardingMutationErrorResponse["action"];
  error: string;
  retryable?: boolean;
  step?: WorkspaceOnboardingMutationErrorResponse["step"];
  validationErrors?: OnboardingValidationError[];
}): WorkspaceOnboardingMutationErrorResponse {
  return {
    action: input.action ?? null,
    error: input.error,
    kind: "onboarding-mutation-error",
    retryable: input.retryable ?? false,
    step: input.step ?? null,
    validationErrors: input.validationErrors ?? [],
  };
}

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
    vercelSandboxConnection: data.vercelSandboxConnection,
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
      mutationErrorResponse({
        error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id.",
        validationErrors: parsedWorkspaceId.error.issues.map((issue) => ({
          field: "workspaceId",
          message: issue.message,
        })),
      }),
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      mutationErrorResponse({
        error: "Invalid JSON body.",
        validationErrors: [{ field: "body", message: "Invalid JSON body." }],
      }),
      { status: 400 },
    );
  }

  const parsed = workspaceOnboardingMutationRequestSchema.safeParse(body);
  if (!parsed.success) {
    const error = parsed.error.issues[0]?.message ?? "Invalid onboarding payload.";
    return NextResponse.json(
      mutationErrorResponse({
        error,
        validationErrors: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      }),
      { status: 400 },
    );
  }

  try {
    const result = await updateWorkspaceOnboardingData(parsedWorkspaceId.data, parsed.data);

    if (!result.ok) {
      if ("conflict" in result) {
        return NextResponse.json(result.conflict, { status: 409 });
      }
      return NextResponse.json(
        mutationErrorResponse({
          action: parsed.data.action,
          error: result.error,
          retryable: result.status >= 500,
          step: parsed.data.step,
        }),
        { status: result.status },
      );
    }

    return NextResponse.json(result.data, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        mutationErrorResponse({
          action: parsed.data.action,
          error: error.issues[0]?.message ?? "Invalid onboarding state.",
          step: parsed.data.step,
          validationErrors: error.issues.map((issue) => ({
            field: issue.path.join(".") || "onboarding",
            message: issue.message,
          })),
        }),
        { status: 500 },
      );
    }

    throw error;
  }
}
