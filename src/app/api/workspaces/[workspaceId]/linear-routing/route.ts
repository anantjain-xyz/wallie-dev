import { NextResponse } from "next/server";

import { linearRoutingUpdateSchema } from "@/lib/linear-routing/contracts";
import { saveLinearRoutingConfig } from "@/lib/linear-routing/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

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

  try {
    const routing = await saveLinearRoutingConfig({
      actorUserId: access.context.user.id,
      admin: createSupabaseAdminClient(),
      config: parsed.data,
      workspaceId: access.context.workspace.id,
    });

    return NextResponse.json({ routing }, { status: 200 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    switch (code) {
      case "PT409":
        return NextResponse.json(
          { error: "The published pipeline changed. Reload the routing options before saving." },
          { status: 409 },
        );
      case "PT422":
        return NextResponse.json(
          { error: "Route targets must be part of the active pipeline." },
          { status: 400 },
        );
      case "42501":
        return NextResponse.json(
          { error: "Active workspace manager access is required." },
          { status: 403 },
        );
      default:
        throw error;
    }
  }
}
