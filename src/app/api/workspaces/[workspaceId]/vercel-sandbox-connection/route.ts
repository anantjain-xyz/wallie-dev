import { NextResponse } from "next/server";

import {
  upsertVercelSandboxConnectionSchema,
  type VercelSandboxConnectionResponse,
} from "@/lib/vercel-sandbox/contracts";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import {
  acquireVercelSandboxConnectionMutationLock,
  loadVercelSandboxConnection,
  loadVercelSandboxConnectionPreview,
  saveVercelSandboxConnection,
  validateVercelSandboxCredentials,
  VercelSandboxConnectionActiveWorkError,
  VercelSandboxConnectionMutationInProgressError,
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
type CapabilityCheckSandboxRow = Pick<
  Tables<"sandbox_capability_checks">,
  "checked_at" | "sandbox_id" | "status" | "workspace_id"
>;

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

  const [runResult, checkResult] = await Promise.all([
    input.admin
      .from("agent_runs")
      .select("sandbox_id, status, workspace_id, agent_job_id")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", input.credentials.teamId)
      .eq("sandbox_vercel_project_id", input.credentials.projectId)
      .in("sandbox_id", sandboxIds),
    input.admin
      .from("sandbox_capability_checks")
      .select("sandbox_id, status, workspace_id, checked_at")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", input.credentials.teamId)
      .eq("sandbox_vercel_project_id", input.credentials.projectId)
      .in("sandbox_id", sandboxIds),
  ]);

  if (runResult.error) throw runResult.error;
  if (checkResult.error) throw checkResult.error;

  const rows = (runResult.data ?? []) as AgentRunSandboxRow[];
  const checkRows = (checkResult.data ?? []) as CapabilityCheckSandboxRow[];
  const activeJobIds = await loadActiveAgentJobIds(
    input.admin,
    rows
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
  const ownedByWorkspace = new Set<string>();
  for (const row of [...rows, ...checkRows]) {
    if (row.workspace_id === input.workspaceId && row.sandbox_id) {
      ownedByWorkspace.add(row.sandbox_id);
    }
  }

  const activeAnywhere = new Set<string>();
  for (const row of rows) {
    if (
      row.sandbox_id &&
      (isActiveRunStatus(row.status) ||
        (row.agent_job_id ? activeJobIds.has(row.agent_job_id) : false))
    ) {
      activeAnywhere.add(row.sandbox_id);
    }
  }
  for (const row of checkRows) {
    if (row.sandbox_id && isActiveCapabilityCheck(row)) {
      activeAnywhere.add(row.sandbox_id);
    }
  }

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

function isActiveCapabilityCheck(row: CapabilityCheckSandboxRow, now = Date.now()) {
  if (row.status !== "running") return false;
  const checkedAt = Date.parse(row.checked_at);
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt <= STALE_SANDBOX_CAPABILITY_CHECK_MS;
}

function connectionMutationConflictResponse(error: unknown) {
  if (
    error instanceof VercelSandboxConnectionActiveWorkError ||
    error instanceof VercelSandboxConnectionMutationInProgressError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return null;
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
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireVercelSandboxConnectionMutationLock(
      admin,
      access.context.workspace.id,
    );

    const validation = await validateVercelSandboxCredentials(parsed.data);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const existingConnection = await loadVercelSandboxConnection(
      admin,
      access.context.workspace.id,
    );
    if (existingConnection) {
      await stopWorkspaceProjectSandboxes({
        admin,
        credentials: existingConnection.credentials,
        workspaceId: access.context.workspace.id,
      });
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
  } catch (error) {
    const conflict = connectionMutationConflictResponse(error);
    if (conflict) return conflict;
    throw error;
  } finally {
    if (releaseLock) {
      await releaseLock();
    }
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireVercelSandboxConnectionMutationLock(
      admin,
      access.context.workspace.id,
    );

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
  } catch (error) {
    const conflict = connectionMutationConflictResponse(error);
    if (conflict) return conflict;
    throw error;
  } finally {
    if (releaseLock) {
      await releaseLock();
    }
  }
}
