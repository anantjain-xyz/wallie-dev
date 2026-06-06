import { NextResponse } from "next/server";

import {
  upsertVercelSandboxConnectionSchema,
  type VercelSandboxConnectionResponse,
} from "@/lib/vercel-sandbox/contracts";
import {
  loadVercelSandboxConnection,
  loadVercelSandboxConnectionPreview,
  saveVercelSandboxConnection,
  validateVercelSandboxCredentials,
} from "@/lib/vercel-sandbox/server";
import { listRunningSandboxes, stopSandboxById } from "@/lib/sandbox";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const activeRunStatuses = ["queued", "started", "running"] as const;
const activeJobStatuses = ["queued", "started", "running"] as const;
type AgentRunSandboxRow = Pick<
  Tables<"agent_runs">,
  "agent_job_id" | "sandbox_id" | "status" | "workspace_id"
>;

async function hasActiveWorkspaceWork(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
}) {
  const [runResult, jobResult] = await Promise.all([
    input.admin
      .from("agent_runs")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .in("status", [...activeRunStatuses])
      .limit(1)
      .maybeSingle(),
    input.admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .in("status", [...activeJobStatuses])
      .limit(1)
      .maybeSingle(),
  ]);

  if (runResult.error) throw runResult.error;
  if (jobResult.error) throw jobResult.error;
  return Boolean(runResult.data || jobResult.data);
}

async function stopWorkspaceProjectSandboxes(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  credentials: NonNullable<Awaited<ReturnType<typeof loadVercelSandboxConnection>>>["credentials"];
  workspaceId: string;
}) {
  const sandboxes = await listRunningSandboxes({
    throwOnError: true,
    vercelCredentials: input.credentials,
  });
  const sandboxIds = sandboxes.map((sandbox) => sandbox.id);

  if (sandboxIds.length === 0) {
    return;
  }

  const { data, error } = await input.admin
    .from("agent_runs")
    .select("sandbox_id, status, workspace_id, agent_job_id")
    .eq("sandbox_provider", "vercel")
    .eq("sandbox_vercel_team_id", input.credentials.teamId)
    .eq("sandbox_vercel_project_id", input.credentials.projectId)
    .in("sandbox_id", sandboxIds);

  if (error) throw error;

  const rows = (data ?? []) as AgentRunSandboxRow[];
  const activeJobIds = await loadActiveAgentJobIds(
    input.admin,
    rows
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
  const ownedByWorkspace = new Set(
    rows
      .filter((row) => row.workspace_id === input.workspaceId)
      .map((row) => row.sandbox_id)
      .filter((id): id is string => id !== null),
  );
  const activeAnywhere = new Set(
    rows
      .filter(
        (row) =>
          isActiveRunStatus(row.status) ||
          (row.agent_job_id ? activeJobIds.has(row.agent_job_id) : false),
      )
      .map((row) => row.sandbox_id)
      .filter((id): id is string => id !== null),
  );

  for (const sandbox of sandboxes) {
    if (!ownedByWorkspace.has(sandbox.id) || activeAnywhere.has(sandbox.id)) {
      continue;
    }

    await stopSandboxById(sandbox.id, {
      throwOnError: true,
      vercelCredentials: input.credentials,
    });
  }
}

function isActiveRunStatus(status: Tables<"agent_runs">["status"]) {
  return activeRunStatuses.includes(status as (typeof activeRunStatuses)[number]);
}

async function loadActiveAgentJobIds(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  jobIds: string[],
) {
  if (jobIds.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .select("id")
    .in("id", [...new Set(jobIds)])
    .in("status", [...activeJobStatuses]);

  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
}

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const response: VercelSandboxConnectionResponse = {
    connection: await loadVercelSandboxConnectionPreview(admin, access.context.workspace.id),
  };

  return NextResponse.json(response, { status: 200 });
}

export async function PUT(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await request.json().catch(() => null);
  const parsed = upsertVercelSandboxConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Vercel connection input is invalid." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  if (await hasActiveWorkspaceWork({ admin, workspaceId: access.context.workspace.id })) {
    return NextResponse.json(
      {
        error:
          "Cannot update Vercel while Wallie runs are queued or running. Wait for them to finish first.",
      },
      { status: 409 },
    );
  }

  const validation = await validateVercelSandboxCredentials(parsed.data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const connection = await saveVercelSandboxConnection({
    admin,
    credentials: parsed.data,
    createdByMemberId: access.context.currentMember.id,
    projectName: validation.projectName,
    workspaceId: access.context.workspace.id,
  });

  return NextResponse.json({ connection } satisfies VercelSandboxConnectionResponse, {
    status: 200,
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  if (await hasActiveWorkspaceWork({ admin, workspaceId: access.context.workspace.id })) {
    return NextResponse.json(
      {
        error:
          "Cannot disconnect Vercel while Wallie runs are queued or running. Wait for them to finish first.",
      },
      { status: 409 },
    );
  }

  const connection = await loadVercelSandboxConnection(admin, access.context.workspace.id);
  if (connection) {
    await stopWorkspaceProjectSandboxes({
      admin,
      credentials: connection.credentials,
      workspaceId: access.context.workspace.id,
    });
  }

  const { error } = await admin
    .from("workspace_vercel_sandbox_connections")
    .delete()
    .eq("workspace_id", access.context.workspace.id);

  if (error) throw error;

  return NextResponse.json({ connection: null } satisfies VercelSandboxConnectionResponse, {
    status: 200,
  });
}
