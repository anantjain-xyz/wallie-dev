import { NextResponse } from "next/server";

import { archiveSession, unarchiveSession } from "@/lib/pipeline/archive";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ sessionId: string }> };

/**
 * Resolve the session for the current user. The server (RLS) client can only
 * read sessions visible through workspace_members, so a non-member gets null →
 * 404. Returns the gating NextResponse on any failure, otherwise the row.
 */
async function resolveSessionForMember(
  sessionId: string,
): Promise<
  | { response: NextResponse; row?: undefined; userId?: undefined }
  | { response?: undefined; row: { id: string; workspace_id: string }; userId: string }
> {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return { response: NextResponse.json({ error: sessionError.message }, { status: 500 }) };
  }
  if (!sessionRow) {
    return { response: NextResponse.json({ error: "Session not found" }, { status: 404 }) };
  }

  return { row: sessionRow, userId: user.id };
}

// Archive the session from any stage. No phase_status gate — a workspace member
// can archive regardless of where the session sits in the pipeline.
export async function POST(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const resolved = await resolveSessionForMember(sessionId);
  if (resolved.response) {
    return resolved.response;
  }

  const gated = await enforceRateLimit(
    "phaseAction",
    `${resolved.row.workspace_id}:${resolved.userId}`,
  );
  if (gated.response) {
    return gated.response;
  }

  const admin = createSupabaseAdminClient();
  const result = await archiveSession(admin, {
    reason: "Session archived by a workspace member.",
    sessionId: resolved.row.id,
  });

  return NextResponse.json({ archivedAt: result.archivedAt, id: result.id });
}

// Unarchive the session, returning it to its prior phase.
export async function DELETE(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const resolved = await resolveSessionForMember(sessionId);
  if (resolved.response) {
    return resolved.response;
  }

  const gated = await enforceRateLimit(
    "phaseAction",
    `${resolved.row.workspace_id}:${resolved.userId}`,
  );
  if (gated.response) {
    return gated.response;
  }

  const admin = createSupabaseAdminClient();
  const result = await unarchiveSession(admin, { sessionId: resolved.row.id });

  return NextResponse.json({ archivedAt: result.archivedAt, id: result.id });
}
