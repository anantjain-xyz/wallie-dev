import { NextResponse } from "next/server";
import { z } from "zod";

import { completeWorkspaceOnboarding } from "@/features/onboarding/data";
import {
  type WorkspaceOnboardingMutationErrorResponse,
  workspaceOnboardingCompletionRequestSchema,
} from "@/lib/onboarding/contracts";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const workspaceIdParamSchema = z.string().uuid("Workspace id must be a valid UUID.");

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdParamSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      {
        action: "complete",
        error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id.",
        kind: "onboarding-mutation-error",
        retryable: false,
        step: "verify",
        validationErrors: parsedWorkspaceId.error.issues.map((issue) => ({
          field: "workspaceId",
          message: issue.message,
        })),
      } satisfies WorkspaceOnboardingMutationErrorResponse,
      { status: 400 },
    );
  }

  const parsedBody = workspaceOnboardingCompletionRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        action: "complete",
        error: parsedBody.error.issues[0]?.message ?? "Invalid onboarding completion payload.",
        kind: "onboarding-mutation-error",
        retryable: false,
        step: "verify",
        validationErrors: parsedBody.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      } satisfies WorkspaceOnboardingMutationErrorResponse,
      { status: 400 },
    );
  }

  const result = await completeWorkspaceOnboarding(
    parsedWorkspaceId.data,
    parsedBody.data.expectedUpdatedAt,
  );

  if (!result.ok) {
    if (result.conflict) {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    return NextResponse.json(
      {
        action: "complete",
        blockers: result.blockers ?? [],
        error: result.error,
        kind: "onboarding-mutation-error",
        retryable: true,
        step: "verify",
        validationErrors: (result.blockers ?? []).map((blocker) => ({
          field: blocker.id,
          message: blocker.detail,
        })),
      },
      { status: result.status },
    );
  }

  return NextResponse.json(result.data, { status: 200 });
}
