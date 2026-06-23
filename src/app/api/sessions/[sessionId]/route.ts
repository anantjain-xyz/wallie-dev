import { NextResponse } from "next/server";
import { z } from "zod";

import {
  normalizeUpdateSessionTitlePayload,
  updateSessionTitlePayloadSchema,
} from "@/features/sessions/update-title";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

const sessionIdSchema = z.string().uuid("Session id is invalid.");

export async function PATCH(request: Request, { params }: Params) {
  const { sessionId } = await params;
  const parsedSessionId = sessionIdSchema.safeParse(sessionId);

  if (!parsedSessionId.success) {
    return NextResponse.json({ error: "Session id is invalid." }, { status: 400 });
  }

  const payload = await request.json().catch(() => null);
  const parsedPayload = updateSessionTitlePayloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    const firstIssue = parsedPayload.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Session title input is invalid.",
      },
      { status: 400 },
    );
  }

  const normalized = normalizeUpdateSessionTitlePayload(parsedPayload.data);
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", parsedSessionId.data)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }

  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const access = await requireWorkspaceAccessById(sessionRow.workspace_id);

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data: updatedRow, error: updateError } = await admin
    .from("sessions")
    .update({ title: normalized.title })
    .eq("id", sessionRow.id)
    .eq("workspace_id", sessionRow.workspace_id)
    .select("id, title, updated_at")
    .single();

  if (updateError || !updatedRow) {
    return NextResponse.json(
      { error: updateError?.message ?? "Wallie could not update that session title." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    id: updatedRow.id,
    title: updatedRow.title,
    updatedAt: updatedRow.updated_at,
  });
}
