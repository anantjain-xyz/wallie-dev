import { NextRequest, NextResponse } from "next/server";

import {
  processAgentJobsSchema,
  type ProcessAgentJobsResponse,
} from "@/features/wallie/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { WALLIE_PROCESS_TOKEN_ENV_KEY } from "@/lib/wallie/constants";
import { processQueuedAgentJobs } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

async function authorizeProcessRoute(
  request: NextRequest,
  payload: {
    jobId?: string;
    workspaceId?: string;
  },
) {
  const configuredToken = process.env[WALLIE_PROCESS_TOKEN_ENV_KEY]?.trim();
  const authorization = request.headers.get("authorization");

  if (configuredToken && authorization === `Bearer ${configuredToken}`) {
    return {
      ok: true as const,
      workspaceId: payload.workspaceId,
    };
  }

  if (payload.workspaceId) {
    const access = await requireWorkspaceAccessById(payload.workspaceId, {
      requireManager: true,
    });

    if (!access.ok) {
      return {
        error: access.error,
        ok: false as const,
        status: access.status,
      };
    }

    return {
      ok: true as const,
      workspaceId: payload.workspaceId,
    };
  }

  if (payload.jobId) {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("agent_jobs")
      .select("workspace_id")
      .eq("id", payload.jobId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return {
        error: "Wallie job not found.",
        ok: false as const,
        status: 404,
      };
    }

    const access = await requireWorkspaceAccessById(data.workspace_id, {
      requireManager: true,
    });

    if (!access.ok) {
      return {
        error: access.error,
        ok: false as const,
        status: access.status,
      };
    }

    return {
      ok: true as const,
      workspaceId: data.workspace_id,
    };
  }

  return {
    error: configuredToken
      ? `Provide Authorization: Bearer <${WALLIE_PROCESS_TOKEN_ENV_KEY}> or process a scoped workspace as a manager.`
      : "Workspace manager access with a scoped job or workspace is required to process Wallie jobs.",
    ok: false as const,
    status: 401,
  };
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) ?? {};
  const parsed = processAgentJobsSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Process request is invalid.",
      },
      { status: 400 },
    );
  }

  const authorization = await authorizeProcessRoute(request, parsed.data);

  if (!authorization.ok) {
    return NextResponse.json(
      {
        error: authorization.error,
      },
      { status: authorization.status },
    );
  }

  const result: ProcessAgentJobsResponse = await processQueuedAgentJobs({
    requestedJobId: parsed.data.jobId,
    workspaceId: parsed.data.workspaceId ?? authorization.workspaceId,
  });

  return NextResponse.json(result, {
    status: result.processed ? 200 : 202,
  });
}
