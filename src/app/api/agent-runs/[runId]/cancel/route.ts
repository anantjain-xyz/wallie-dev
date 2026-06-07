import { NextResponse } from "next/server";

import {
  cancelAgentRunParamsSchema,
  cancelAgentRunSchema,
  type AgentRunCancelResponse,
} from "@/features/wallie/contracts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { buildAgentRunActionErrorResponse, buildAgentRunCancelResponse } from "@/lib/wallie/http";
import { cancelWallieRun } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type CancelAgentRunRouteProps = {
  params: Promise<{
    runId: string;
  }>;
};

export async function POST(request: Request, { params }: CancelAgentRunRouteProps) {
  const [payload, rawParams] = await Promise.all([request.json().catch(() => null), params]);
  const parsedBody = cancelAgentRunSchema.safeParse(payload);
  const parsedParams = cancelAgentRunParamsSchema.safeParse(rawParams);

  if (!parsedBody.success || !parsedParams.success) {
    const firstIssue = parsedBody.error?.issues[0] ?? parsedParams.error?.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Cancel request is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedBody.data.workspaceId);

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const gated = await enforceRateLimit(
    "agentRuns",
    `${access.context.workspace.id}:${access.context.user.id}`,
  );
  if (gated.response) {
    return gated.response;
  }

  try {
    const result = await cancelWallieRun({
      requestedByMemberId: access.context.currentMember.id,
      runId: parsedParams.data.runId,
      workspace: access.context.workspace,
    });

    const response: AgentRunCancelResponse = buildAgentRunCancelResponse({
      canceled: result.canceled,
      run: result.run,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    const response = buildAgentRunActionErrorResponse(error);

    return NextResponse.json(response.body, {
      status: response.status,
    });
  }
}
