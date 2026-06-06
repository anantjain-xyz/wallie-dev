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
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const activeRunStatuses = ["queued", "started", "running"] as const;

async function hasActiveWorkspaceRuns(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
}) {
  const { data, error } = await input.admin
    .from("agent_runs")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .in("status", [...activeRunStatuses])
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function stopWorkspaceProjectSandboxes(input: {
  credentials: NonNullable<Awaited<ReturnType<typeof loadVercelSandboxConnection>>>["credentials"];
}) {
  const sandboxes = await listRunningSandboxes({ vercelCredentials: input.credentials });

  for (const sandbox of sandboxes) {
    await stopSandboxById(sandbox.id, { vercelCredentials: input.credentials });
  }
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

  const validation = await validateVercelSandboxCredentials(parsed.data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
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
  if (await hasActiveWorkspaceRuns({ admin, workspaceId: access.context.workspace.id })) {
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
    await stopWorkspaceProjectSandboxes({ credentials: connection.credentials });
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
