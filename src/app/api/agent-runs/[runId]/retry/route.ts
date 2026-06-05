import { NextResponse } from "next/server";

import {
  retryAgentRunParamsSchema,
  retryAgentRunSchema,
  type AgentRunActionResponse,
} from "@/features/wallie/contracts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { buildAgentRunActionErrorResponse, buildAgentRunActionResponse } from "@/lib/wallie/http";
import { retryWallieRun } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RetryAgentRunRouteProps = {
  params: Promise<{
    runId: string;
  }>;
};

export async function POST(request: Request, { params }: RetryAgentRunRouteProps) {
  const [payload, rawParams] = await Promise.all([request.json().catch(() => null), params]);
  const parsedBody = retryAgentRunSchema.safeParse(payload);
  const parsedParams = retryAgentRunParamsSchema.safeParse(rawParams);

  if (!parsedBody.success || !parsedParams.success) {
    const firstIssue = parsedBody.error?.issues[0] ?? parsedParams.error?.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Retry request is invalid.",
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
    const result = await retryWallieRun({
      requestedByMemberId: access.context.currentMember.id,
      runId: parsedParams.data.runId,
      supabase: access.context.supabase,
      workspace: access.context.workspace,
    });
    const processScheduled = result.created && result.jobId !== null;

    const response: AgentRunActionResponse = buildAgentRunActionResponse({
      created: result.created,
      processScheduled,
      run: result.run,
    });

    return NextResponse.json(response, {
      status: result.created ? 201 : 200,
    });
  } catch (error) {
    const response = buildAgentRunActionErrorResponse(error);

    return NextResponse.json(response.body, {
      status: response.status,
    });
  }
}
