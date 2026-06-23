import { NextResponse } from "next/server";

import { cancelSessionWork } from "@/lib/pipeline/cancel";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Membership check via RLS: the server client can only read sessions the
  // current user can see through workspace_members. A non-member gets null → 404.
  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id, phase_status")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Only the in-flight generation can be canceled. Anything else (awaiting
  // review, approved, already rejected) has no active run to stop.
  if (sessionRow.phase_status !== "agent_generating") {
    return NextResponse.json({ error: "Session is not generating." }, { status: 409 });
  }

  const gated = await enforceRateLimit("phaseAction", `${sessionRow.workspace_id}:${user.id}`);
  if (gated.response) {
    return gated.response;
  }

  // Mutations run through the admin client because agent_jobs are service-only
  // under RLS.
  const admin = createSupabaseAdminClient();
  await cancelSessionWork(admin, {
    parkPhaseStatus: true,
    reason: "Stage canceled by a workspace member.",
    sessionId: sessionRow.id,
  });

  return NextResponse.json({ success: true });
}
