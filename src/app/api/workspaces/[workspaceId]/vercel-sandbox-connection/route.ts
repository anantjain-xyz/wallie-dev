import { NextResponse } from "next/server";

import {
  upsertVercelSandboxConnectionSchema,
  type VercelSandboxConnectionResponse,
} from "@/lib/vercel-sandbox/contracts";
import { stopVercelWorkspaceOwnedSandboxes } from "@/lib/sandbox-connections/cleanup";
import { loadWorkspaceSandboxSettings } from "@/lib/sandbox-connections/server";
import {
  acquireVercelSandboxConnectionMutationLock,
  loadVercelSandboxConnection,
  loadVercelSandboxConnectionPreview,
  saveVercelSandboxConnection,
  validateVercelSandboxCredentials,
  VercelSandboxConnectionActiveWorkError,
  VercelSandboxConnectionMutationInProgressError,
} from "@/lib/vercel-sandbox/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function connectionMutationConflictResponse(error: unknown) {
  if (
    error instanceof VercelSandboxConnectionActiveWorkError ||
    error instanceof VercelSandboxConnectionMutationInProgressError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return null;
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
      await stopVercelWorkspaceOwnedSandboxes({
        admin,
        connection: {
          credentials: existingConnection.credentials,
          provider: "vercel",
          revision:
            existingConnection.preview.connectionRevision ?? existingConnection.preview.updatedAt,
        },
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

    const settings = await loadWorkspaceSandboxSettings(admin, access.context.workspace.id);
    if (settings.activeProvider === "vercel") {
      return NextResponse.json(
        { error: "Switch to another sandbox provider before disconnecting Vercel Sandbox." },
        { status: 409 },
      );
    }

    const connection = await loadVercelSandboxConnection(admin, access.context.workspace.id);
    if (connection) {
      await stopVercelWorkspaceOwnedSandboxes({
        admin,
        connection: {
          credentials: connection.credentials,
          provider: "vercel",
          revision: connection.preview.connectionRevision ?? connection.preview.updatedAt,
        },
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
