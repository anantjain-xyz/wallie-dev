import { NextResponse } from "next/server";

import { sandboxCapabilityCheckRequestSchema } from "@/lib/sandbox-capabilities/contracts";
import { runAndRecordSandboxCapabilityCheck } from "@/lib/sandbox-capabilities/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

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
  const check = await runAndRecordSandboxCapabilityCheck({
    admin,
    repositoryId: parsed.data.repositoryId,
    userId: access.context.user.id,
    workspaceId: access.context.workspace.id,
  });

  return NextResponse.json({ check }, { status: 200 });
}
