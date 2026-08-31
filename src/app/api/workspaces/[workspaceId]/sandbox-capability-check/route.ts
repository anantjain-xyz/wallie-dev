import { after, NextResponse } from "next/server";
import { z } from "zod";

import { sandboxCapabilityCheckRequestSchema } from "@/lib/sandbox-capabilities/contracts";
import {
  completeSandboxCapabilityCheck,
  getLatestSandboxCapabilityCheck,
  startSandboxCapabilityCheck,
} from "@/lib/sandbox-capabilities/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const sandboxCapabilityCheckQuerySchema = z.object({
  repositoryId: z.string().uuid("Repository id is invalid."),
});

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const url = new URL(request.url);
  const parsed = sandboxCapabilityCheckQuerySchema.safeParse({
    repositoryId: url.searchParams.get("repositoryId"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid capability check request." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const check = await getLatestSandboxCapabilityCheck({
    admin,
    repositoryId: parsed.data.repositoryId,
    workspaceId: access.context.workspace.id,
  });

  return NextResponse.json({ check }, { status: 200 });
}

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = sandboxCapabilityCheckRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid capability check request." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const started = await startSandboxCapabilityCheck({
    admin,
    repositoryId: parsed.data.repositoryId,
    workspaceId: access.context.workspace.id,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Sandbox connection update")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    throw error;
  });

  if (started instanceof NextResponse) {
    return started;
  }

  after(async () => {
    try {
      await completeSandboxCapabilityCheck({
        admin,
        checkId: started.check.id,
        repository: started.repository,
        userId: access.context.user.id,
        workspaceId: access.context.workspace.id,
      });
    } catch (error) {
      console.error("[sandbox-capability-check] background probe failed", {
        error: error instanceof Error ? error.message : String(error),
        checkId: started.check.id,
        workspaceId: access.context.workspace.id,
      });
    }
  });

  return NextResponse.json({ check: started.check }, { status: 202 });
}
