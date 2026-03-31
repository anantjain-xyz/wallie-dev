import { after, NextResponse } from "next/server";

import {
  enqueueAgentRunSchema,
  type AgentRunActionResponse,
} from "@/features/wallie/contracts";
import { buildAgentRunActionErrorResponse, buildAgentRunActionResponse } from "@/lib/wallie/http";
import {
  enqueueWallieRun,
  processQueuedAgentJobs,
} from "@/lib/wallie/service";
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

  try {
    const result = await enqueueWallieRun({
      issueId: parsed.data.issueId,
      requestedByMemberId: access.context.currentMember.id,
      supabase: access.context.supabase,
      triggerType: "manual_run",
      workspace: access.context.workspace,
    });
    const processScheduled = result.created && result.jobId !== null;

    if (processScheduled && result.jobId) {
      after(async () => {
        try {
          await processQueuedAgentJobs({
            requestedJobId: result.jobId ?? undefined,
          });
        } catch (error) {
          console.error("Wallie enqueue follow-up processing failed", {
            error,
            jobId: result.jobId,
          });
        }
      });
    }

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
