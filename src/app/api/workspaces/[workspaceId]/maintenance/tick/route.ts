import { NextResponse } from "next/server";

import { runMaintenanceTick } from "@/lib/maintenance/service";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const gated = await enforceRateLimit(
    "maintenance",
    `${access.context.workspace.id}:${access.context.user.id}`,
  );
  if (gated.response) {
    return gated.response;
  }

  const admin = createSupabaseAdminClient();
  const result = await runMaintenanceTick({
    admin,
    workspaceId: access.context.workspace.id,
  });

  return NextResponse.json(result, { status: 200 });
}
