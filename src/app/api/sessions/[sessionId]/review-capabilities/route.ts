import { NextResponse } from "next/server";

import { loadSessionReviewCapabilities } from "@/features/sessions/detail/review-capabilities";
import type { SessionMutationErrorResponse } from "@/features/sessions/mutation-contracts";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "unauthorized", error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, current_stage_id, workspace_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "mutation_failed", error: error.message },
      { status: 500 },
    );
  }
  if (!session) {
    return NextResponse.json<SessionMutationErrorResponse>(
      { code: "not_found", error: "Session not found" },
      { status: 404 },
    );
  }

  const capabilities = await loadSessionReviewCapabilities({
    memberUserId: user.id,
    sessionId: session.id,
    stageId: session.current_stage_id,
    supabase,
    workspaceId: session.workspace_id,
  });

  return NextResponse.json(capabilities);
}
