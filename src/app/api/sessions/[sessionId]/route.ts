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

type Params = { params: Promise<{ sessionId: string }> };

const sessionIdSchema = z.string().uuid("Session id is invalid.");

export async function PATCH(request: Request, { params }: Params) {
  const { sessionId: rawSessionId } = await params;
  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId);

  if (!parsedSessionId.success) {
    return NextResponse.json({ error: "Session id is invalid." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsedPayload = updateSessionTitlePayloadSchema.safeParse(body);
  if (!parsedPayload.success) {
    const firstIssue = parsedPayload.error.issues[0];

    return NextResponse.json(
      { error: firstIssue?.message ?? "Session title is invalid." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = parsedSessionId.data;
  const normalized = normalizeUpdateSessionTitlePayload(parsedPayload.data);

  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }

  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  const access = await requireWorkspaceAccessById(sessionRow.workspace_id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data: updatedSession, error: updateError } = await admin
    .from("sessions")
    .update({ title: normalized.title })
    .eq("id", sessionId)
    .eq("workspace_id", access.context.workspace.id)
    .select("id, title, updated_at")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (!updatedSession) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  return NextResponse.json({
    id: updatedSession.id,
    title: updatedSession.title,
    updatedAt: updatedSession.updated_at,
  });
}
