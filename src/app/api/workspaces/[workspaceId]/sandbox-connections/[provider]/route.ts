import { NextResponse } from "next/server";

import {
  sandboxProviderSchema,
  upsertDaytonaSandboxConnectionSchema,
  upsertE2BSandboxConnectionSchema,
} from "@/lib/sandbox-connections/contracts";
import {
  acquireSandboxConnectionMutationLock,
  getEnabledSandboxProviders,
  loadWorkspaceSandboxConnection,
  loadWorkspaceSandboxOverview,
  loadWorkspaceSandboxSettings,
  SandboxConnectionActiveWorkError,
  SandboxConnectionInvalidError,
  SandboxConnectionMutationInProgressError,
  saveDaytonaSandboxConnection,
  saveE2BSandboxConnection,
  stopWorkspaceOwnedSandboxes,
  validateDaytonaSandboxCredentials,
  validateE2BSandboxCredentials,
} from "@/lib/sandbox-connections/server";
import { stopVercelWorkspaceOwnedSandboxes } from "@/lib/sandbox-connections/cleanup";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { upsertVercelSandboxConnectionSchema } from "@/lib/vercel-sandbox/contracts";
import {
  saveVercelSandboxConnection,
  validateVercelSandboxCredentials,
} from "@/lib/vercel-sandbox/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ provider: string; workspaceId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const params = await parseContext(context);
  if (params.response) return params.response;
  const access = await requireWorkspaceAccessById(params.workspaceId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const overview = await loadWorkspaceSandboxOverview(
    createSupabaseAdminClient(),
    access.context.workspace.id,
  );
  return NextResponse.json({ connection: overview.connections[params.provider] });
}

export async function PUT(request: Request, context: RouteContext) {
  const params = await parseContext(context);
  if (params.response) return params.response;
  const access = await requireWorkspaceAccessById(params.workspaceId, { requireManager: true });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (!getEnabledSandboxProviders().includes(params.provider)) {
    return NextResponse.json({ error: "Sandbox provider is disabled." }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  const admin = createSupabaseAdminClient();
  let release: (() => Promise<void>) | null = null;

  try {
    release = await acquireSandboxConnectionMutationLock(
      admin,
      access.context.workspace.id,
      params.provider,
    );
    const existing = await loadExistingConnectionForCleanup(
      admin,
      access.context.workspace.id,
      params.provider,
    );

    if (params.provider === "e2b") {
      const parsed = upsertE2BSandboxConnectionSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
      const validation = await validateE2BSandboxCredentials(parsed.data);
      if (!validation.ok) return invalid(validation.error);
      if (existing)
        await stopWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      const connection = await saveE2BSandboxConnection({
        admin,
        apiKey: parsed.data.apiKey,
        createdByMemberId: access.context.currentMember.id,
        workspaceId: access.context.workspace.id,
      });
      return NextResponse.json({ connection });
    }

    if (params.provider === "daytona") {
      const parsed = upsertDaytonaSandboxConnectionSchema.safeParse(body);
      if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
      let validation;
      try {
        validation = await validateDaytonaSandboxCredentials(parsed.data);
      } catch (error) {
        return invalid(error instanceof Error ? error.message : undefined);
      }
      if (!validation.ok) return invalid(validation.error);
      if (existing)
        await stopWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      const connection = await saveDaytonaSandboxConnection({
        admin,
        apiKey: validation.credentials.apiKey,
        apiUrl: validation.credentials.apiUrl!,
        createdByMemberId: access.context.currentMember.id,
        target: validation.credentials.target,
        workspaceId: access.context.workspace.id,
      });
      return NextResponse.json({ connection });
    }

    const parsed = upsertVercelSandboxConnectionSchema.safeParse(body);
    if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
    const validation = await validateVercelSandboxCredentials(parsed.data);
    if (!validation.ok) return invalid(validation.error);
    if (existing) {
      if (existing.connection.provider === "vercel") {
        await stopVercelWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      } else {
        await stopWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      }
    }
    const connection = await saveVercelSandboxConnection({
      admin,
      credentials: parsed.data,
      createdByMemberId: access.context.currentMember.id,
      projectName: validation.projectName,
      workspaceId: access.context.workspace.id,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    if (
      error instanceof SandboxConnectionActiveWorkError ||
      error instanceof SandboxConnectionMutationInProgressError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  } finally {
    if (release) await release();
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const params = await parseContext(context);
  if (params.response) return params.response;
  const access = await requireWorkspaceAccessById(params.workspaceId, { requireManager: true });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const admin = createSupabaseAdminClient();
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireSandboxConnectionMutationLock(
      admin,
      access.context.workspace.id,
      params.provider,
    );
    const settings = await loadWorkspaceSandboxSettings(admin, access.context.workspace.id);
    if (settings.activeProvider === params.provider) {
      return NextResponse.json(
        {
          error: `Switch to another sandbox provider before disconnecting ${providerLabel(params.provider)}.`,
        },
        { status: 409 },
      );
    }
    const existing = await loadExistingConnectionForCleanup(
      admin,
      access.context.workspace.id,
      params.provider,
    );
    if (existing) {
      if (existing.connection.provider === "vercel") {
        await stopVercelWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      } else {
        await stopWorkspaceOwnedSandboxes({
          admin,
          connection: existing.connection,
          workspaceId: access.context.workspace.id,
        });
      }
    }
    const table =
      params.provider === "vercel"
        ? "workspace_vercel_sandbox_connections"
        : params.provider === "e2b"
          ? "workspace_e2b_sandbox_connections"
          : "workspace_daytona_sandbox_connections";
    const { error } = await admin
      .from(table)
      .delete()
      .eq("workspace_id", access.context.workspace.id);
    if (error) throw error;
    return NextResponse.json({ connection: null });
  } catch (error) {
    if (
      error instanceof SandboxConnectionActiveWorkError ||
      error instanceof SandboxConnectionMutationInProgressError
    )
      return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  } finally {
    if (release) await release();
  }
}

async function loadExistingConnectionForCleanup(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
  provider: "daytona" | "e2b" | "vercel",
) {
  try {
    return await loadWorkspaceSandboxConnection(admin, workspaceId, provider);
  } catch (error) {
    if (provider === "daytona" && error instanceof SandboxConnectionInvalidError) {
      console.warn("[sandbox-connection] skipping cleanup for policy-rejected Daytona endpoint", {
        error: error.message,
        workspaceId,
      });
      return null;
    }
    throw error;
  }
}

function providerLabel(provider: "daytona" | "e2b" | "vercel") {
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  return "Vercel Sandbox";
}

function invalid(message?: string) {
  return NextResponse.json(
    { error: message || "Sandbox connection input is invalid." },
    { status: 400 },
  );
}

async function parseContext(
  context: RouteContext,
): Promise<
  | { provider: "daytona" | "e2b" | "vercel"; response?: never; workspaceId: string }
  | { provider?: never; response: NextResponse; workspaceId?: never }
> {
  const { provider, workspaceId } = await context.params;
  const parsed = sandboxProviderSchema.safeParse(provider);
  if (!parsed.success) {
    return {
      response: NextResponse.json({ error: "Unsupported sandbox provider." }, { status: 404 }),
    };
  }
  return { provider: parsed.data, workspaceId };
}
