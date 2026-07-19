import { NextResponse } from "next/server";

import { enqueueAgentRunSchema, type AgentRunActionResponse } from "@/features/wallie/contracts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { loadAttemptOrdinalForRun } from "@/features/wallie/server";
import { buildAgentRunActionErrorResponse, buildAgentRunActionResponse } from "@/lib/wallie/http";
import { enqueueWallieRun } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = enqueueAgentRunSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Run request is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId);

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
    const result = await enqueueWallieRun({
      sessionId: parsed.data.sessionId,
      requestedByMemberId: access.context.currentMember.id,
      supabase: access.context.supabase,
      triggerType: "manual_run",
      workspace: access.context.workspace,
    });
    const processScheduled = result.created && result.jobId !== null;
    const attemptCount = await loadAttemptOrdinalForRun(result.run.session_id, result.run.id).catch(
      () => 1,
    );

    const response: AgentRunActionResponse = buildAgentRunActionResponse({
      attemptCount,
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
