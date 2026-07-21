import { NextResponse } from "next/server";

import { updateSandboxSettingsSchema } from "@/lib/sandbox-connections/contracts";
import {
  loadWorkspaceSandboxOverview,
  SandboxConnectionActiveWorkError,
  SandboxConnectionInvalidError,
  SandboxConnectionMissingError,
  SandboxConnectionMutationInProgressError,
  setActiveSandboxProvider,
} from "@/lib/sandbox-connections/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const settings = await loadWorkspaceSandboxOverview(
    createSupabaseAdminClient(),
    access.context.workspace.id,
  );
  return NextResponse.json(settings);
}

export async function PATCH(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const parsed = updateSandboxSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Sandbox setting is invalid." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  try {
    await setActiveSandboxProvider({
      admin,
      expectedRevision: parsed.data.expectedRevision,
      memberId: access.context.currentMember.id,
      provider: parsed.data.activeProvider,
      workspaceId: access.context.workspace.id,
    });
    return NextResponse.json(
      await loadWorkspaceSandboxOverview(admin, access.context.workspace.id),
    );
  } catch (error) {
    if (
      error instanceof SandboxConnectionActiveWorkError ||
      error instanceof SandboxConnectionMutationInProgressError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof SandboxConnectionMissingError ||
      error instanceof SandboxConnectionInvalidError
    ) {
      return NextResponse.json({ error: error.message, provider: error.provider }, { status: 400 });
    }
    if (error instanceof Error && error.message.includes("Refresh")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
