import { z } from "zod";

import { runRetentionSchema } from "@/lib/run-exports/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  if (!z.string().uuid().safeParse(workspaceId).success) {
    return Response.json({ error: "Invalid workspace id." }, { status: 400, headers });
  }

  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status, headers });
  }

  const { data, error } = await access.context.supabase
    .from("workspace_run_retention")
    .select("transcript_days, evidence_days")
    .eq("workspace_id", access.context.workspace.id)
    .maybeSingle();
  if (error) {
    return Response.json({ error: "Could not load run retention." }, { status: 500, headers });
  }
  return Response.json(
    {
      retention: {
        transcriptDays: data?.transcript_days ?? null,
        evidenceDays: data?.evidence_days ?? null,
      },
    },
    { headers },
  );
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  if (!z.string().uuid().safeParse(workspaceId).success) {
    return Response.json({ error: "Invalid workspace id." }, { status: 400, headers });
  }

  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status, headers });
  }

  const retention = runRetentionSchema.safeParse(await request.json().catch(() => null));
  if (!retention.success) {
    return Response.json(
      { error: "Enter a whole number of days for each limit, or leave it blank." },
      { status: 400, headers },
    );
  }

  const { data, error } = await createSupabaseAdminClient().rpc("save_workspace_run_retention", {
    p_workspace_id: access.context.workspace.id,
    p_actor_user_id: access.context.user.id,
    p_transcript_days: retention.data.transcriptDays ?? undefined,
    p_evidence_days: retention.data.evidenceDays ?? undefined,
  });
  if (error?.code === "42501") {
    return Response.json(
      { error: "Workspace admin access is required." },
      { status: 403, headers },
    );
  }
  if (error?.code === "P0002") {
    return Response.json({ error: "Workspace not found." }, { status: 404, headers });
  }
  if (error || !data) {
    return Response.json({ error: "Could not save run retention." }, { status: 500, headers });
  }

  return Response.json(
    { retention: { transcriptDays: data.transcript_days, evidenceDays: data.evidence_days } },
    { headers },
  );
}
