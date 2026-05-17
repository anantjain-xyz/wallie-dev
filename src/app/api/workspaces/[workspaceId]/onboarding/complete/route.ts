import { NextResponse } from "next/server";
import { z } from "zod";

import { completeWorkspaceOnboarding } from "@/features/onboarding/data";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const workspaceIdParamSchema = z.string().uuid("Workspace id must be a valid UUID.");

export async function POST(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdParamSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      { error: parsedWorkspaceId.error.issues[0]?.message ?? "Invalid workspace id." },
      { status: 400 },
    );
  }

  const result = await completeWorkspaceOnboarding(parsedWorkspaceId.data);

  if (!result.ok) {
    return NextResponse.json(
      { blockers: result.blockers ?? [], error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(result.data, { status: 200 });
}
