import { NextResponse } from "next/server";

import { linearRoutingUpdateSchema } from "@/lib/linear-routing/contracts";
import {
  loadLinearRoutingConfig,
  upsertLinearRoutingConfig,
  validateLinearRoutingStages,
} from "@/lib/linear-routing/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const routing = await loadLinearRoutingConfig(admin, access.context.workspace.id);
  return NextResponse.json({ routing }, { status: 200 });
}

export async function PUT(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = linearRoutingUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid Linear routing config." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const stageValidation = await validateLinearRoutingStages({
    admin,
    config: parsed.data,
    workspaceId: access.context.workspace.id,
  });
  if (!stageValidation.ok) {
    return NextResponse.json(
      { error: stageValidation.error ?? "Invalid routing stage slugs." },
      { status: 400 },
    );
  }

  const routing = await upsertLinearRoutingConfig({
    admin,
    config: parsed.data,
    workspaceId: access.context.workspace.id,
  });

  return NextResponse.json({ routing }, { status: 200 });
}
